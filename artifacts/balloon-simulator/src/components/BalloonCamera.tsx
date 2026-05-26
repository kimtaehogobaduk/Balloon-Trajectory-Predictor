import { useEffect, useRef } from "react";
import type { TrajectoryPoint } from "@workspace/api-client-react";
import { Play, Pause, ChevronLeft } from "lucide-react";

interface BalloonCameraProps {
  trajectory: TrajectoryPoint[];
  animFrame: number;
  setAnimFrame: (f: number) => void;
  isPlaying: boolean;
  setIsPlaying: (p: boolean) => void;
  playSpeed: number;
  setPlaySpeed: (s: number) => void;
  onClose: () => void;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Cloud {
  x: number;       // canvas pixels
  y: number;
  speed: number;   // px/sec (horizontal drift)
  size: number;
  opacity: number;
  puffs: { dx: number; dy: number; r: number }[];
}

interface Bird {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  wingPhase: number;
  wingSpeed: number; // rad/sec
}

interface Airplane {
  active: boolean;
  x: number;
  y: number;
  dirRight: boolean;
  speed: number;         // px/sec
  contrail: { x: number; y: number }[];
  nextSpawnIn: number;   // seconds until next spawn
}

// ─── Entity helpers ───────────────────────────────────────────────────────────

function makePuffs(size: number, count: number) {
  const puffs: { dx: number; dy: number; r: number }[] = [];
  for (let i = 0; i < count; i++) {
    puffs.push({
      dx: (Math.random() - 0.5) * size * 1.9,
      dy: (Math.random() - 0.5) * size * 0.65,
      r:  size * (0.28 + Math.random() * 0.44),
    });
  }
  return puffs;
}

function spawnCloud(w: number, h: number, startX?: number): Cloud {
  const size = 45 + Math.random() * 90;
  return {
    x:       startX ?? Math.random() * w,
    y:       h * (0.08 + Math.random() * 0.52),
    speed:   6 + Math.random() * 18,
    size,
    opacity: 0.55 + Math.random() * 0.38,
    puffs:   makePuffs(size, 5 + Math.floor(Math.random() * 5)),
  };
}

function spawnBird(w: number, h: number): Bird {
  return {
    x: Math.random() * w,
    y: h * (0.25 + Math.random() * 0.45),
    vx: (Math.random() < 0.5 ? -1 : 1) * (30 + Math.random() * 55),
    vy: (Math.random() - 0.5) * 12,
    size: 7 + Math.random() * 9,
    wingPhase: Math.random() * Math.PI * 2,
    wingSpeed: 3.5 + Math.random() * 3.5,
  };
}

// ─── Draw helpers ─────────────────────────────────────────────────────────────

function drawCloud(
  ctx: CanvasRenderingContext2D,
  cloud: Cloud,
  horizonY: number,
  altOpacity: number
) {
  const { x, y, puffs, opacity } = cloud;
  const a = opacity * altOpacity;
  if (a <= 0.01 || y > horizonY - 10) return;

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  for (const p of puffs) {
    const px = x + p.dx;
    const py = y + p.dy;
    if (py >= horizonY) continue;
    const grad = ctx.createRadialGradient(px, py, p.r * 0.1, px, py, p.r);
    grad.addColorStop(0,    `rgba(255,255,255,${a * 0.95})`);
    grad.addColorStop(0.4,  `rgba(245,249,255,${a * 0.72})`);
    grad.addColorStop(0.75, `rgba(225,235,255,${a * 0.3})`);
    grad.addColorStop(1,    `rgba(200,220,255,0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawBird(
  ctx: CanvasRenderingContext2D,
  bird: Bird,
  horizonY: number,
  altitude: number
) {
  if (bird.y > horizonY || altitude > 3200) return;
  const { x, y, size, wingPhase } = bird;
  const amp = size * 0.55 * Math.sin(wingPhase);
  ctx.save();
  ctx.strokeStyle = "rgba(12, 8, 4, 0.85)";
  ctx.lineWidth = Math.max(1, size * 0.1);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x - size,       y + amp);
  ctx.quadraticCurveTo(x - size * 0.48, y - amp * 0.35, x, y);
  ctx.quadraticCurveTo(x + size * 0.48, y - amp * 0.35, x + size, y + amp);
  ctx.stroke();
  // Body dot
  ctx.fillStyle = "rgba(12, 8, 4, 0.7)";
  ctx.beginPath();
  ctx.arc(x, y, size * 0.09, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawAirplane(
  ctx: CanvasRenderingContext2D,
  ap: Airplane
) {
  const { x, y, dirRight, contrail } = ap;

  // Contrail (fades out behind)
  if (contrail.length > 1) {
    for (let i = 1; i < contrail.length; i++) {
      const t = i / contrail.length;
      const a = t * 0.45;
      ctx.strokeStyle = `rgba(240,244,255,${a})`;
      ctx.lineWidth = 1.8 * t;
      ctx.beginPath();
      ctx.moveTo(contrail[i - 1].x, contrail[i - 1].y - 3);
      ctx.lineTo(contrail[i].x,     contrail[i].y - 3);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(contrail[i - 1].x, contrail[i - 1].y + 3);
      ctx.lineTo(contrail[i].x,     contrail[i].y + 3);
      ctx.stroke();
    }
  }

  ctx.save();
  ctx.translate(x, y);
  if (!dirRight) ctx.scale(-1, 1);

  const fill = "rgba(195,205,218,0.93)";
  ctx.fillStyle = fill;

  // Fuselage
  ctx.beginPath();
  ctx.ellipse(0, 0, 19, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // Nose cone
  ctx.beginPath();
  ctx.moveTo(17, 0);
  ctx.lineTo(26, 0.5);
  ctx.lineTo(17, 3);
  ctx.closePath();
  ctx.fill();

  // Main wing (swept)
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(3, 0);
    ctx.lineTo(-3, side * 17);
    ctx.lineTo(-7, side * 17);
    ctx.lineTo(-4, 0);
    ctx.closePath();
    ctx.fill();
  }

  // Horizontal stabilizers
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(-12, 0);
    ctx.lineTo(-15, side * 7);
    ctx.lineTo(-17, side * 7);
    ctx.lineTo(-14, 0);
    ctx.closePath();
    ctx.fill();
  }

  // Vertical tail fin
  ctx.beginPath();
  ctx.moveTo(-13, 0);
  ctx.lineTo(-17, -9);
  ctx.lineTo(-13, -9);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// ─── Noise helper (Perlin-like approximation) ─────────────────────────────────

function noise(t: number, f1: number, f2: number): number {
  return Math.sin(t * f1) * 0.65 + Math.sin(t * f2 * 1.618) * 0.35;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BalloonCamera({
  trajectory,
  animFrame,
  setAnimFrame,
  isPlaying,
  setIsPlaying,
  playSpeed,
  setPlaySpeed,
  onClose,
}: BalloonCameraProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Keep hot props in refs so the render loop never restarts just because they changed
  const frameRef    = useRef(animFrame);
  const playingRef  = useRef(isPlaying);
  const speedRef    = useRef(playSpeed);

  useEffect(() => { frameRef.current   = animFrame; },  [animFrame]);
  useEffect(() => { playingRef.current = isPlaying; },  [isPlaying]);
  useEffect(() => { speedRef.current   = playSpeed; },  [playSpeed]);

  // Canvas resize
  useEffect(() => {
    const resize = () => {
      if (canvasRef.current) {
        canvasRef.current.width  = window.innerWidth;
        canvasRef.current.height = window.innerHeight;
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Main render loop — only restarts when trajectory changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !trajectory.length) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = () => canvas.width;
    const H = () => canvas.height;

    // ── Init entities ────────────────────────────────────────────────────────
    const CLOUD_COUNT = 10;
    const BIRD_COUNT  = 12;

    const clouds: Cloud[]    = Array.from({ length: CLOUD_COUNT }, () => spawnCloud(W(), H()));
    const birds:  Bird[]     = Array.from({ length: BIRD_COUNT  }, () => spawnBird(W(), H()));
    // Stable star positions (seeded)
    const stars = Array.from({ length: 220 }, (_, i) => ({
      x: ((i * 1731 + 13) % 997) / 997,
      y: ((i * 2417 + 7)  % 983) / 983,
      s: 0.6 + ((i * 311) % 100) / 100 * 1.6,
    }));
    const airplane: Airplane = {
      active: false, x: 0, y: 0, dirRight: true,
      speed: 0, contrail: [], nextSpawnIn: 8 + Math.random() * 20,
    };

    let animId: number;
    let lastTs  = 0;
    let wallSec = 0;         // real-world seconds elapsed
    let gridOff = 0;

    const render = (ts: number) => {
      const dt = Math.min((ts - lastTs) / 1000, 0.08);
      lastTs = ts;
      wallSec += dt;

      const fi  = Math.min(frameRef.current, trajectory.length - 1);
      const pt  = trajectory[fi];
      const alt = pt.altitude;
      const w   = W(), h = H();
      const horizonY  = h * 0.54;
      const groundOpa = Math.max(0, 1 - alt / 14000);
      const cloudOpa  = Math.max(0, 1 - alt / 9000);
      const birdOpa   = alt < 2800 ? Math.max(0, 1 - alt / 2800) : 0;
      const starOpa   = Math.max(0, (alt - 7500) / 16000);

      // ── Camera shake ──────────────────────────────────────────────────────
      const shakeAmp = Math.min(pt.wind_speed * 0.28, 9);
      const sx = noise(wallSec, 2.3, 7.1) * shakeAmp;
      const sy = noise(wallSec, 1.7, 5.4) * shakeAmp * 0.55;

      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(sx, sy);

      // ── Sky gradient ──────────────────────────────────────────────────────
      const skyGrad = ctx.createLinearGradient(0, 0, 0, horizonY);
      if      (alt <  2000) { skyGrad.addColorStop(0, "#09152a"); skyGrad.addColorStop(1, "#17376b"); }
      else if (alt < 10000) { skyGrad.addColorStop(0, "#0d2655"); skyGrad.addColorStop(1, "#05101e"); }
      else if (alt < 28000) { skyGrad.addColorStop(0, "#020811"); skyGrad.addColorStop(1, "#010306"); }
      else                  { skyGrad.addColorStop(0, "#010306"); skyGrad.addColorStop(1, "#000204"); }
      ctx.fillStyle = skyGrad;
      ctx.fillRect(-4, -4, w + 8, horizonY + 4);

      // ── Stars ─────────────────────────────────────────────────────────────
      if (starOpa > 0.01) {
        ctx.fillStyle = `rgba(255,255,255,${starOpa})`;
        for (const star of stars) {
          ctx.beginPath();
          ctx.arc(star.x * w, star.y * horizonY * 0.95, star.s, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // ── Clouds ────────────────────────────────────────────────────────────
      if (cloudOpa > 0.01) {
        for (const cloud of clouds) {
          cloud.x += cloud.speed * dt * (1 + pt.wind_speed * 0.04);
          if (cloud.x - cloud.size * 1.8 > w) {
            Object.assign(cloud, spawnCloud(w, h, -cloud.size * 2));
          }
          drawCloud(ctx, cloud, horizonY, cloudOpa);
        }
      }

      // ── Ground ────────────────────────────────────────────────────────────
      if (groundOpa > 0.01) {
        const gGrad = ctx.createLinearGradient(0, horizonY, 0, h);
        gGrad.addColorStop(0, `rgba(22,15,4,${groundOpa})`);
        gGrad.addColorStop(1, `rgba(10,7,2,${groundOpa})`);
        ctx.fillStyle = gGrad;
        ctx.fillRect(-4, horizonY, w + 8, h - horizonY + 4);

        // Perspective grid
        gridOff = (gridOff + pt.horizontal_speed * 0.55 * dt * 60) % 45;
        ctx.strokeStyle = `rgba(130, 90, 40, ${groundOpa * 0.28})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let gy = horizonY; gy < h + 46; gy += (gy - horizonY) / 12 + 2.2) {
          const off = gridOff * ((gy - horizonY) / (h - horizonY + 1));
          ctx.moveTo(-4,    gy + off);
          ctx.lineTo(w + 4, gy + off);
        }
        const cx2 = w / 2 + sx * -0.8;
        for (let gx = -w * 0.5; gx < w * 1.5; gx += 55) {
          ctx.moveTo(cx2, horizonY);
          ctx.lineTo(gx, h + 4);
        }
        ctx.stroke();
      }

      // ── Horizon line (tilts with wind vector) ──────────────────────────────
      const bearRad   = (pt.bearing * Math.PI) / 180;
      const tilt      = Math.atan2(
        pt.wind_speed * Math.sin(bearRad),
        pt.wind_speed * Math.cos(bearRad)
      ) * 0.06;
      ctx.save();
      ctx.translate(w / 2, horizonY);
      ctx.rotate(tilt);
      ctx.strokeStyle = `rgba(190, 215, 255, ${Math.max(0.18, groundOpa * 0.85)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-w, 0);
      ctx.lineTo(w,  0);
      ctx.stroke();
      ctx.restore();

      // ── Birds ─────────────────────────────────────────────────────────────
      if (birdOpa > 0.01) {
        for (const bird of birds) {
          bird.x         += bird.vx * dt;
          bird.y         += bird.vy * dt;
          bird.wingPhase += bird.wingSpeed * dt;
          // slight turbulence drift
          bird.vy += noise(wallSec + bird.wingPhase, 1.2, 3.7) * 6 * dt;
          bird.vy  = Math.max(-18, Math.min(18, bird.vy));
          // wrap
          if (bird.x < -bird.size * 2)  bird.x = w + bird.size;
          if (bird.x > w + bird.size * 2) bird.x = -bird.size;
          if (bird.y < h * 0.15) bird.vy = Math.abs(bird.vy);
          if (bird.y > horizonY - 20)    bird.vy = -Math.abs(bird.vy);

          ctx.globalAlpha = birdOpa;
          drawBird(ctx, bird, horizonY, alt);
          ctx.globalAlpha = 1;
        }
      }

      // ── Airplane ──────────────────────────────────────────────────────────
      airplane.nextSpawnIn -= dt;
      const planeAlt = alt;
      if (!airplane.active && airplane.nextSpawnIn <= 0 && planeAlt > 3000 && planeAlt < 13000) {
        airplane.active   = true;
        airplane.dirRight = Math.random() < 0.5;
        airplane.x        = airplane.dirRight ? -40 : w + 40;
        airplane.y        = horizonY * (0.1 + Math.random() * 0.55);
        airplane.speed    = 280 + Math.random() * 160;
        airplane.contrail = [];
        airplane.nextSpawnIn = 15 + Math.random() * 35;
      }
      if (airplane.active) {
        airplane.x += (airplane.dirRight ? 1 : -1) * airplane.speed * dt;
        airplane.contrail.unshift({ x: airplane.x, y: airplane.y });
        if (airplane.contrail.length > 80) airplane.contrail.pop();
        drawAirplane(ctx, airplane);
        if (airplane.x < -80 || airplane.x > w + 80) {
          airplane.active = false;
        }
      }

      // ── Scanlines ──────────────────────────────────────────────────────────
      // Drawn before restoring shake so they stay fixed on screen
      ctx.restore(); // end shake transform

      ctx.save();
      for (let y2 = 0; y2 < h; y2 += 3) {
        ctx.fillStyle = "rgba(0,0,0,0.08)";
        ctx.fillRect(0, y2, w, 1);
      }
      ctx.restore();

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [trajectory]); // Only trajectory restarts the loop

  const pt = trajectory[Math.min(animFrame, trajectory.length - 1)];
  if (!pt) return null;

  const launchMs  = new Date(trajectory[0].time).getTime();
  const tPlus     = Math.floor((new Date(pt.time).getTime() - launchMs) / 1000);
  const hh = String(Math.floor(tPlus / 3600)).padStart(2, "0");
  const mm = String(Math.floor((tPlus % 3600) / 60)).padStart(2, "0");
  const ss = String(tPlus % 60).padStart(2, "0");

  return (
    <div className="fixed inset-0 z-50 bg-black text-white font-mono overflow-hidden select-none">
      <canvas ref={canvasRef} className="absolute inset-0" />

      {/* HUD layer */}
      <div className="relative z-10 flex flex-col h-full p-5">

        {/* Top bar */}
        <div className="flex items-start justify-between">

          {/* Back to map — prominent */}
          <button
            data-testid="button-back-to-map"
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-2 rounded bg-black/60 border border-white/25 text-xs font-bold tracking-wider hover:bg-white/15 transition-colors pointer-events-auto"
          >
            <ChevronLeft className="w-4 h-4" />
            BACK TO MAP
          </button>

          {/* Timer + phase */}
          <div className="flex flex-col items-center gap-1 pointer-events-none">
            <span className="text-xl font-bold tracking-[0.15em] drop-shadow">T+ {hh}:{mm}:{ss}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${
              pt.phase === "ascent"
                ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/50"
                : "bg-orange-500/20 text-orange-300 border-orange-500/50"
            }`}>
              {pt.phase.toUpperCase()}
            </span>
          </div>

          {/* Playback controls */}
          <div className="flex items-center gap-2 pointer-events-auto">
            <div className="flex bg-black/60 rounded border border-white/20 overflow-hidden text-[11px]">
              {[1, 5, 10, 20].map(s => (
                <button
                  key={s}
                  data-testid={`button-speed-${s}x`}
                  onClick={() => setPlaySpeed(s)}
                  className={`px-2 py-1.5 transition-colors ${playSpeed === s ? "bg-white/90 text-black font-bold" : "text-white/65 hover:bg-white/12"}`}
                >
                  {s}x
                </button>
              ))}
            </div>
            <button
              data-testid="button-play-pause"
              onClick={() => setIsPlaying(!isPlaying)}
              className="w-8 h-8 flex items-center justify-center rounded bg-black/60 border border-white/25 hover:bg-white/15 transition-colors"
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Centre reticle */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="relative w-56 h-56 opacity-30">
            <div className="absolute inset-0 rounded-full border border-white/40" />
            <div className="absolute top-1/2 left-0 right-0 h-px bg-white/50 -translate-y-px" />
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/50 -translate-x-px" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full border border-white/80" />
          </div>
        </div>

        {/* Left HUD */}
        <div className="mt-auto mb-16 flex flex-col gap-3 pointer-events-none drop-shadow-lg">
          <HudValue label="ALTITUDE"  value={`${pt.altitude.toLocaleString()} m`} size="lg" />
          <HudValue label="V.SPEED"   value={`${pt.vertical_speed > 0 ? "+" : ""}${pt.vertical_speed.toFixed(1)} m/s`}
                    color={pt.vertical_speed >= 0 ? "text-green-400" : "text-red-400"} />
          <HudValue label="H.SPEED"   value={`${pt.horizontal_speed.toFixed(1)} m/s`} color="text-cyan-400" />
          <HudValue label="TOTAL"     value={`${pt.total_speed.toFixed(1)} m/s`} />
        </div>

        {/* Right HUD */}
        <div className="absolute bottom-20 right-5 flex flex-col gap-3 items-end pointer-events-none drop-shadow-lg">
          <HudValue label="WIND"     value={`${pt.wind_speed.toFixed(1)} m/s`} color="text-yellow-300" align="right" />
          <HudValue label="DIR"      value={`${pt.wind_direction}°`} color="text-yellow-300/80" align="right" />
          <HudValue label="PRESSURE" value={`${pt.pressure_hpa.toFixed(0)} hPa`} color="text-white/70" align="right" />
          <HudValue label="BEARING"  value={`${pt.bearing}°`} align="right" />
        </div>

        {/* Bottom scrubber */}
        <div className="pointer-events-auto mt-auto">
          <div className="flex items-center gap-3 px-3 py-2 bg-black/50 rounded border border-white/15 backdrop-blur">
            <span className="text-[10px] text-white/45 w-6 shrink-0">0%</span>
            <input
              data-testid="input-scrubber"
              type="range"
              min="0"
              max={trajectory.length - 1}
              value={animFrame}
              onChange={e => setAnimFrame(Number(e.target.value))}
              className="flex-1 accent-white h-1 cursor-pointer"
            />
            <span className="text-[10px] text-white/45 w-8 shrink-0 text-right">100%</span>
          </div>

          {/* Progress bar */}
          <div className="mt-1.5 h-px bg-white/10 rounded overflow-hidden">
            <div
              className="h-full bg-white/40 transition-none"
              style={{ width: `${(animFrame / (trajectory.length - 1)) * 100}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function HudValue({
  label, value, color = "text-white", size = "base", align = "left",
}: {
  label: string;
  value: string;
  color?: string;
  size?: "base" | "lg";
  align?: "left" | "right";
}) {
  return (
    <div className={`flex flex-col ${align === "right" ? "items-end" : "items-start"}`}>
      <span className="text-[9px] text-white/40 tracking-widest">{label}</span>
      <span className={`font-bold leading-tight ${color} ${size === "lg" ? "text-3xl" : "text-lg"}`}>
        {value}
      </span>
    </div>
  );
}
