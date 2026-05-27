import { useRef, useMemo, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Stars, Line } from "@react-three/drei";
import * as THREE from "three";
import type { TrajectoryPoint } from "@workspace/api-client-react";
import { X, Globe } from "lucide-react";

// ─── Constants ────────────────────────────────────────────────────────────────

const EARTH_R       = 1.0;           // scene units
const EARTH_KM      = 6371;          // km
const ALT_SCALE     = 80;            // exaggerate altitude so trajectory is visible
const ATM_R         = EARTH_R * 1.015;

// ─── Coord helpers ────────────────────────────────────────────────────────────

function toVec3(lat: number, lng: number, altM = 0): THREE.Vector3 {
  const latR = (lat * Math.PI) / 180;
  const lngR = (lng * Math.PI) / 180;
  const r = EARTH_R + ((altM / 1000) / EARTH_KM) * ALT_SCALE;
  return new THREE.Vector3(
    r * Math.cos(latR) * Math.cos(lngR),
    r * Math.sin(latR),
    r * Math.cos(latR) * Math.sin(lngR),
  );
}

function centroid(pts: TrajectoryPoint[]): THREE.Vector3 {
  const sum = new THREE.Vector3();
  for (const p of pts) sum.add(toVec3(p.latitude, p.longitude, p.altitude / 2));
  return sum.divideScalar(pts.length).normalize().multiplyScalar(EARTH_R);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Earth() {
  const meshRef = useRef<THREE.Mesh>(null);
  const atmRef  = useRef<THREE.Mesh>(null);

  useFrame((_, dt) => {
    if (meshRef.current) meshRef.current.rotation.y += dt * 0.01;
    if (atmRef.current)  atmRef.current.rotation.y  += dt * 0.008;
  });

  return (
    <group>
      {/* Core sphere */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[EARTH_R, 64, 64]} />
        <meshPhongMaterial
          color="#1a3a5c"
          emissive="#0a1f33"
          specular="#4488cc"
          shininess={30}
        />
      </mesh>
      {/* Continent hints (slightly brighter equatorial band) */}
      <mesh>
        <sphereGeometry args={[EARTH_R + 0.0005, 48, 48]} />
        <meshPhongMaterial
          color="#1e5c3a"
          transparent
          opacity={0.18}
          emissive="#0a2015"
        />
      </mesh>
      {/* Atmosphere glow */}
      <mesh ref={atmRef}>
        <sphereGeometry args={[ATM_R, 48, 48]} />
        <meshPhongMaterial
          color="#3399ff"
          transparent
          opacity={0.07}
          side={THREE.BackSide}
        />
      </mesh>
    </group>
  );
}

function GridLines() {
  const lines = useMemo(() => {
    const result: { points: THREE.Vector3[]; opacity: number }[] = [];
    const segs = 128;
    for (let lat = -80; lat <= 80; lat += 20) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= segs; i++) {
        const lng = -180 + (i / segs) * 360;
        pts.push(toVec3(lat, lng, 0).multiplyScalar(1.001));
      }
      result.push({ points: pts, opacity: lat === 0 ? 0.25 : 0.1 });
    }
    for (let lng = -180; lng < 180; lng += 20) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= segs / 2; i++) {
        const lat = -90 + (i / (segs / 2)) * 180;
        pts.push(toVec3(lat, lng, 0).multiplyScalar(1.001));
      }
      result.push({ points: pts, opacity: 0.08 });
    }
    return result;
  }, []);

  return (
    <>
      {lines.map((l, i) => (
        <Line key={i} points={l.points} color="#4488bb" lineWidth={0.4} transparent opacity={l.opacity} />
      ))}
    </>
  );
}

function Trajectory({
  trajectory,
  animFrame,
}: {
  trajectory: TrajectoryPoint[];
  animFrame: number;
}) {
  const balloonRef = useRef<THREE.Mesh>(null);

  const { ascentPts, descentPts } = useMemo(() => {
    const asc  = trajectory.filter(p => p.phase === "ascent").map(p => toVec3(p.latitude, p.longitude, p.altitude));
    const desc = trajectory.filter(p => p.phase === "descent").map(p => toVec3(p.latitude, p.longitude, p.altitude));
    return { ascentPts: asc, descentPts: desc };
  }, [trajectory]);

  const launchPt  = useMemo(() => toVec3(trajectory[0].latitude,  trajectory[0].longitude,  0),           [trajectory]);
  const burstPt   = useMemo(() => { const b = trajectory.find(p => p.phase === "descent"); return b ? toVec3(b.latitude, b.longitude, b.altitude) : null; }, [trajectory]);
  const landingPt = useMemo(() => toVec3(trajectory[trajectory.length - 1].latitude, trajectory[trajectory.length - 1].longitude, 0), [trajectory]);

  const frame = Math.min(animFrame, trajectory.length - 1);
  const pt    = trajectory[frame];
  const balloonPos = useMemo(() => toVec3(pt.latitude, pt.longitude, pt.altitude), [pt]);

  useFrame(({ clock }) => {
    if (balloonRef.current) {
      const pulse = 1 + 0.3 * Math.sin(clock.elapsedTime * 4);
      balloonRef.current.scale.setScalar(pulse);
      balloonRef.current.position.copy(balloonPos);
    }
  });

  return (
    <group>
      {/* Ascent path — cyan */}
      {ascentPts.length >= 2 && (
        <Line points={ascentPts} color="#06b6d4" lineWidth={2.5} />
      )}
      {/* Descent path — orange */}
      {descentPts.length >= 2 && (
        <Line points={descentPts} color="#f97316" lineWidth={2.5} />
      )}

      {/* Launch marker — green */}
      <mesh position={launchPt}>
        <sphereGeometry args={[0.008, 16, 16]} />
        <meshStandardMaterial color="#10b981" emissive="#10b981" emissiveIntensity={1.5} />
      </mesh>

      {/* Burst marker — yellow */}
      {burstPt && (
        <mesh position={burstPt}>
          <sphereGeometry args={[0.006, 16, 16]} />
          <meshStandardMaterial color="#eab308" emissive="#eab308" emissiveIntensity={1.5} />
        </mesh>
      )}

      {/* Landing marker — red */}
      <mesh position={landingPt}>
        <sphereGeometry args={[0.008, 16, 16]} />
        <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={1.5} />
      </mesh>

      {/* Animated balloon — cyan pulsing */}
      <mesh ref={balloonRef} position={balloonPos}>
        <sphereGeometry args={[0.01, 16, 16]} />
        <meshStandardMaterial color="#22d3ee" emissive="#22d3ee" emissiveIntensity={2} />
      </mesh>

      {/* Vertical drop lines from each path point to surface */}
      {[...ascentPts, ...descentPts].filter((_, i) => i % 8 === 0).map((p, i) => {
        const surface = p.clone().normalize().multiplyScalar(EARTH_R);
        return <Line key={i} points={[p, surface]} color="#ffffff" lineWidth={0.3} transparent opacity={0.08} />;
      })}
    </group>
  );
}

function CameraRig({ center }: { center: THREE.Vector3 }) {
  const { camera } = useThree();
  useEffect(() => {
    const offset = center.clone().normalize().multiplyScalar(2.2);
    camera.position.copy(offset);
    camera.lookAt(center);
  }, [camera, center]);
  return null;
}

function Scene({
  trajectory,
  animFrame,
}: {
  trajectory: TrajectoryPoint[];
  animFrame: number;
}) {
  const center = useMemo(() => centroid(trajectory), [trajectory]);

  return (
    <>
      <ambientLight intensity={0.3} />
      <directionalLight position={[5, 3, 5]} intensity={1.2} color="#ffffff" />
      <directionalLight position={[-5, -2, -3]} intensity={0.2} color="#4488cc" />
      <Stars radius={10} depth={5} count={3000} factor={0.5} saturation={0.5} fade speed={0.5} />
      <Earth />
      <GridLines />
      <Trajectory trajectory={trajectory} animFrame={animFrame} />
      <CameraRig center={center} />
      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        minDistance={1.1}
        maxDistance={6}
        target={center}
      />
    </>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

interface Globe3DProps {
  trajectory: TrajectoryPoint[];
  animFrame: number;
  onClose: () => void;
}

export default function Globe3D({ trajectory, animFrame, onClose }: Globe3DProps) {
  const pt = trajectory[Math.min(animFrame, trajectory.length - 1)];

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-cyan-400" />
          <span className="text-xs font-bold uppercase tracking-widest text-cyan-300 font-mono">3D GLOBE VIEW</span>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
        >
          <X className="w-4 h-4 text-white" />
        </button>
      </div>

      {/* Canvas */}
      <Canvas camera={{ fov: 45, near: 0.01, far: 100 }} gl={{ antialias: true }}>
        <Scene trajectory={trajectory} animFrame={animFrame} />
      </Canvas>

      {/* Telemetry overlay */}
      <div className="absolute bottom-4 left-4 z-10 flex gap-3 flex-wrap">
        <div className="px-3 py-2 bg-black/70 border border-cyan-500/30 rounded-lg backdrop-blur font-mono text-[10px] space-y-0.5">
          <div className="text-muted-foreground uppercase tracking-wider text-[9px]">Altitude</div>
          <div className="text-cyan-300 font-bold text-sm">{(pt.altitude / 1000).toFixed(1)} km</div>
        </div>
        <div className="px-3 py-2 bg-black/70 border border-border rounded-lg backdrop-blur font-mono text-[10px] space-y-0.5">
          <div className="text-muted-foreground uppercase tracking-wider text-[9px]">Phase</div>
          <div className={`font-bold text-sm ${pt.phase === "ascent" ? "text-cyan-400" : "text-orange-400"}`}>
            {pt.phase.toUpperCase()}
          </div>
        </div>
        <div className="px-3 py-2 bg-black/70 border border-border rounded-lg backdrop-blur font-mono text-[10px] space-y-0.5">
          <div className="text-muted-foreground uppercase tracking-wider text-[9px]">Wind</div>
          <div className="text-white font-bold text-sm">{pt.wind_speed.toFixed(1)} m/s</div>
        </div>
        <div className="px-3 py-2 bg-black/70 border border-border rounded-lg backdrop-blur font-mono text-[10px] space-y-0.5">
          <div className="text-muted-foreground uppercase tracking-wider text-[9px]">Position</div>
          <div className="text-white font-bold text-sm">{pt.latitude.toFixed(3)}°, {pt.longitude.toFixed(3)}°</div>
        </div>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-1.5 px-3 py-2 bg-black/70 border border-border rounded-lg backdrop-blur font-mono text-[10px]">
        <div className="flex items-center gap-2"><div className="w-3 h-0.5 bg-cyan-400 rounded" /><span className="text-muted-foreground">Ascent</span></div>
        <div className="flex items-center gap-2"><div className="w-3 h-0.5 bg-orange-400 rounded" /><span className="text-muted-foreground">Descent</span></div>
        <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-green-500" /><span className="text-muted-foreground">Launch</span></div>
        <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-yellow-400" /><span className="text-muted-foreground">Burst</span></div>
        <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-red-500" /><span className="text-muted-foreground">Landing</span></div>
        <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-cyan-400" /><span className="text-muted-foreground">Balloon</span></div>
        <div className="border-t border-border/50 mt-1 pt-1 text-[9px] text-muted-foreground/60">고도 80배 과장 표시</div>
      </div>

      {/* Hint */}
      <div className="absolute top-14 left-1/2 -translate-x-1/2 z-10 px-3 py-1 bg-black/60 border border-border/40 rounded-full text-[10px] text-muted-foreground font-mono">
        드래그로 회전 · 스크롤로 줌
      </div>
    </div>
  );
}
