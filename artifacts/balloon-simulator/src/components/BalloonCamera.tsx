import { useEffect, useRef } from "react";
import type { TrajectoryPoint } from "@workspace/api-client-react";
import { Play, Pause, X } from "lucide-react";
import { Button } from "@/components/ui/button";

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

export default function BalloonCamera({
  trajectory,
  animFrame,
  setAnimFrame,
  isPlaying,
  setIsPlaying,
  playSpeed,
  setPlaySpeed,
  onClose
}: BalloonCameraProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const starsRef = useRef<{ x: number; y: number; s: number }[]>([]);

  useEffect(() => {
    // Generate stars
    if (starsRef.current.length === 0) {
      const stars = [];
      for (let i = 0; i < 200; i++) {
        stars.push({
          x: Math.random(),
          y: Math.random(),
          s: Math.random() * 2 + 0.5
        });
      }
      starsRef.current = stars;
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !trajectory || trajectory.length === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationId: number;
    let gridOffset = 0;

    const render = () => {
      if (!canvas || !ctx) return;
      const width = canvas.width;
      const height = canvas.height;
      const pt = trajectory[animFrame];
      
      ctx.clearRect(0, 0, width, height);

      const alt = pt.altitude;
      const horizonY = height * 0.55;

      // Sky Layer
      const skyGrad = ctx.createLinearGradient(0, 0, 0, horizonY);
      if (alt < 2000) {
        skyGrad.addColorStop(0, "#0a1628");
        skyGrad.addColorStop(1, "#1a3a6e");
      } else if (alt < 12000) {
        skyGrad.addColorStop(0, "#0f2a5c");
        skyGrad.addColorStop(1, "#061020");
      } else if (alt < 30000) {
        skyGrad.addColorStop(0, "#030a1a");
        skyGrad.addColorStop(1, "#010308");
      } else {
        skyGrad.addColorStop(0, "#010308");
        skyGrad.addColorStop(1, "#000305");
      }
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, width, horizonY);

      // Stars
      if (alt > 8000) {
        const starOpacity = Math.min(1, (alt - 8000) / 17000);
        ctx.fillStyle = `rgba(255, 255, 255, ${starOpacity})`;
        starsRef.current.forEach(star => {
          ctx.beginPath();
          ctx.arc(star.x * width, star.y * horizonY, star.s, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      // Ground Layer
      const groundOpacity = Math.max(0, 1 - alt / 15000);
      ctx.fillStyle = `rgba(26, 18, 5, ${groundOpacity})`;
      ctx.fillRect(0, horizonY, width, height - horizonY);

      if (groundOpacity > 0) {
        // Perspective Grid
        ctx.strokeStyle = `rgba(150, 100, 50, ${groundOpacity * 0.3})`;
        ctx.lineWidth = 1;
        
        gridOffset = (gridOffset + pt.horizontal_speed * 0.5) % 40;
        
        ctx.beginPath();
        for (let y = horizonY; y < height; y += (y - horizonY) / 10 + 2) {
          ctx.moveTo(0, y + (gridOffset * ((y - horizonY)/height)));
          ctx.lineTo(width, y + (gridOffset * ((y - horizonY)/height)));
        }
        
        const centerX = width / 2;
        for (let x = -width; x < width * 2; x += 100) {
          ctx.moveTo(centerX, horizonY);
          ctx.lineTo(x, height);
        }
        ctx.stroke();
      }

      // Horizon Line
      const vx = pt.horizontal_speed * Math.cos(pt.bearing * Math.PI / 180);
      const vy = pt.horizontal_speed * Math.sin(pt.bearing * Math.PI / 180);
      const tiltAngle = Math.atan2(vx, vy) * 0.05;
      
      ctx.save();
      ctx.translate(width/2, horizonY);
      ctx.rotate(tiltAngle);
      ctx.strokeStyle = `rgba(200, 220, 255, ${Math.max(0.2, groundOpacity)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-width, 0);
      ctx.lineTo(width, 0);
      ctx.stroke();
      ctx.restore();

      animationId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [trajectory, animFrame]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = window.innerWidth;
        canvasRef.current.height = window.innerHeight;
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const pt = trajectory[animFrame];
  if (!pt) return null;

  const launchTime = new Date(trajectory[0].time).getTime();
  const currentTime = new Date(pt.time).getTime();
  const tPlus = Math.floor((currentTime - launchTime) / 1000);
  const hours = String(Math.floor(tPlus / 3600)).padStart(2, "0");
  const mins = String(Math.floor((tPlus % 3600) / 60)).padStart(2, "0");
  const secs = String(tPlus % 60).padStart(2, "0");

  const progress = (animFrame / (trajectory.length - 1)) * 100;

  return (
    <div className="fixed inset-0 z-50 bg-black text-white font-mono flex flex-col overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-cover" />
      
      {/* Scanlines */}
      <div className="absolute inset-0 pointer-events-none" style={{
        background: "repeating-linear-gradient(0deg, rgba(0,0,0,0.15), rgba(0,0,0,0.15) 1px, transparent 1px, transparent 2px)"
      }} />

      {/* HUD Content */}
      <div className="relative z-10 p-6 flex flex-col h-full pointer-events-none">
        
        {/* Top Header */}
        <div className="flex justify-between items-start">
          <div className="pointer-events-auto flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => setIsPlaying(!isPlaying)} className="bg-black/50 border-white/20 hover:bg-white/20 text-white">
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </Button>
            <div className="flex bg-black/50 rounded border border-white/20 overflow-hidden text-xs">
              {[1, 5, 10, 20].map(s => (
                <button 
                  key={s} 
                  onClick={() => setPlaySpeed(s)}
                  className={`px-2 py-1.5 ${playSpeed === s ? "bg-white text-black font-bold" : "text-white/70 hover:bg-white/10"}`}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>

          <div className="text-center flex flex-col items-center">
            <div className="text-xl font-bold tracking-widest text-shadow-sm">T+ {hours}:{mins}:{secs}</div>
            <div className={`text-xs px-2 py-0.5 rounded font-bold mt-1 ${pt.phase === "ascent" ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/50" : "bg-orange-500/20 text-orange-400 border border-orange-500/50"}`}>
              {pt.phase.toUpperCase()}
            </div>
          </div>

          <Button variant="ghost" size="icon" onClick={onClose} className="pointer-events-auto text-white/70 hover:text-white hover:bg-white/10">
            <X className="w-6 h-6" />
          </Button>
        </div>

        {/* Reticle */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-50">
          <div className="w-64 h-64 border border-white/20 rounded-full flex items-center justify-center relative">
            <div className="w-2 h-2 border border-white rounded-full"></div>
            <div className="absolute w-full h-px bg-white/20"></div>
            <div className="absolute w-px h-full bg-white/20"></div>
          </div>
        </div>

        {/* HUD Data */}
        <div className="flex-1 flex items-center justify-between mt-10">
          
          <div className="flex flex-col gap-4 text-sm text-shadow-sm">
            <div>
              <div className="text-white/50 text-[10px]">ALTITUDE</div>
              <div className="text-3xl font-bold">{pt.altitude.toFixed(0)} <span className="text-lg">m</span></div>
            </div>
            <div>
              <div className="text-white/50 text-[10px]">VERTICAL SPEED</div>
              <div className={`text-xl ${pt.vertical_speed >= 0 ? "text-green-400" : "text-red-400"}`}>
                {pt.vertical_speed > 0 ? "+" : ""}{pt.vertical_speed.toFixed(1)} m/s
              </div>
            </div>
            <div>
              <div className="text-white/50 text-[10px]">HORIZONTAL SPEED</div>
              <div className="text-xl text-cyan-400">{pt.horizontal_speed.toFixed(1)} m/s</div>
            </div>
            <div>
              <div className="text-white/50 text-[10px]">TOTAL SPEED</div>
              <div className="text-xl">{pt.total_speed.toFixed(1)} m/s</div>
            </div>
          </div>

          <div className="flex flex-col gap-4 text-sm text-shadow-sm text-right">
            <div>
              <div className="text-white/50 text-[10px]">WIND</div>
              <div className="text-xl text-yellow-400">{pt.wind_speed.toFixed(1)} m/s</div>
              <div className="text-yellow-400/70">@ {pt.wind_direction.toFixed(0)}°</div>
            </div>
            <div>
              <div className="text-white/50 text-[10px]">PRESSURE</div>
              <div className="text-xl text-white/80">{pt.pressure_hpa.toFixed(1)} hPa</div>
            </div>
            <div>
              <div className="text-white/50 text-[10px]">BEARING</div>
              <div className="text-xl">{pt.bearing.toFixed(0)}°</div>
            </div>
          </div>

        </div>

        {/* Scrubber / Bottom Controls */}
        <div className="mt-auto pointer-events-auto">
          <div className="flex items-center gap-4 bg-black/40 p-2 rounded backdrop-blur border border-white/10">
            <span className="text-xs text-white/50">0%</span>
            <input 
              type="range" 
              min="0" 
              max={trajectory.length - 1} 
              value={animFrame}
              onChange={(e) => setAnimFrame(parseInt(e.target.value))}
              className="w-full flex-1 accent-white" 
            />
            <span className="text-xs text-white/50">100%</span>
          </div>
        </div>

      </div>
    </div>
  );
}
