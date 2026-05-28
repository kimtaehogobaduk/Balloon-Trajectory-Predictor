import { useRef, useMemo, Suspense } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, Line, Html, Text } from "@react-three/drei";
import * as THREE from "three";
import { X, RotateCw } from "lucide-react";
import type { TrajectoryPoint } from "@workspace/api-client-react";

interface Route3DProps {
  trajectory: TrajectoryPoint[];
  animFrame?: number;
  onClose: () => void;
}

// ── Coordinate helpers ─────────────────────────────────────────────────────────

interface WorldPoint {
  pos: THREE.Vector3;
  alt: number;
  phase: string;
  wind_speed: number;
  latitude: number;
  longitude: number;
}

interface WorldData {
  points: WorldPoint[];
  center: { lat: number; lng: number };
  scale: number;
  vScale: number;
  maxAlt: number;
}

function buildWorldPoints(traj: TrajectoryPoint[]): WorldData {
  if (traj.length === 0) {
    return { points: [], center: { lat: 0, lng: 0 }, scale: 1, vScale: 1, maxAlt: 1 };
  }

  const avgLat = traj.reduce((s, p) => s + p.latitude,  0) / traj.length;
  const avgLng = traj.reduce((s, p) => s + p.longitude, 0) / traj.length;
  const cosLat = Math.cos((avgLat * Math.PI) / 180);

  const kmPerLat = 111;
  const kmPerLng = 111 * cosLat;

  const xs = traj.map(p => (p.longitude - avgLng) * kmPerLng);
  const ys = traj.map(p => p.altitude / 1000);
  const zs = traj.map(p => (p.latitude  - avgLat) * kmPerLat);

  const maxH   = Math.max(...xs.map(Math.abs), ...zs.map(Math.abs), 1);
  const maxAlt = Math.max(...ys, 1);

  const hScale = 4 / maxH;
  const vScale = 3 / maxAlt;

  const points: WorldPoint[] = traj.map((p, i) => ({
    pos: new THREE.Vector3(xs[i] * hScale, ys[i] * vScale, zs[i] * hScale),
    alt: p.altitude,
    phase: p.phase,
    wind_speed: p.wind_speed,
    latitude: p.latitude,
    longitude: p.longitude,
  }));

  return { points, center: { lat: avgLat, lng: avgLng }, scale: hScale, vScale, maxAlt };
}

// ── Scene component ────────────────────────────────────────────────────────────

function Scene({ trajectory, animFrame }: { trajectory: TrajectoryPoint[]; animFrame?: number }) {
  const { points, vScale, maxAlt } = useMemo(() => buildWorldPoints(trajectory), [trajectory]);

  const ascentPts  = points.filter(p => p.phase === "ascent").map(p => p.pos);
  const descentPts = points.filter(p => p.phase === "descent").map(p => p.pos);

  // Ground shadow (projection onto y=0)
  const shadowPts = points.map(p => new THREE.Vector3(p.pos.x, 0.005, p.pos.z));

  const burstIdx   = points.findIndex(p => p.phase === "descent");
  const burstPt    = burstIdx >= 0 ? points[burstIdx] : null;
  const launchPt   = points[0];
  const landingPt  = points[points.length - 1];

  const isAnim  = animFrame !== undefined && animFrame >= 0 && animFrame < points.length;
  const curPt   = isAnim ? points[Math.min(animFrame!, points.length - 1)] : null;
  const curTraj = isAnim ? trajectory[Math.min(animFrame!, trajectory.length - 1)] : null;
  const activePts = isAnim ? points.slice(0, Math.min(animFrame! + 1, points.length)).map(p => p.pos) : [];

  // Vertical altitude scale bar
  const altTicks = [0, 10, 20, 30, 40].filter(km => km <= maxAlt + 5);

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 10, 5]} intensity={0.8} />
      <pointLight position={[0, 5, 0]} intensity={0.4} color="#22d3ee" />

      {/* Ground grid */}
      <Grid
        args={[20, 20]}
        cellSize={0.5}
        cellThickness={0.3}
        cellColor="#1e3a4a"
        sectionSize={2}
        sectionThickness={0.8}
        sectionColor="#0e7490"
        fadeDistance={30}
        fadeStrength={1}
        position={[0, 0, 0]}
      />

      {/* Ground shadow of path */}
      {shadowPts.length >= 2 && (
        <Line points={shadowPts} color="#06b6d4" lineWidth={1.5} transparent opacity={0.25} />
      )}

      {/* Ascent path */}
      {ascentPts.length >= 2 && (
        <Line
          points={ascentPts}
          color="#0ea5e9"
          lineWidth={isAnim ? 1.5 : 3}
          transparent
          opacity={isAnim ? 0.3 : 0.95}
        />
      )}

      {/* Descent path */}
      {descentPts.length >= 2 && (
        <Line
          points={descentPts}
          color="#f97316"
          lineWidth={isAnim ? 1.5 : 3}
          transparent
          opacity={isAnim ? 0.3 : 0.95}
        />
      )}

      {/* Animation active trail */}
      {isAnim && activePts.length >= 2 && (
        <Line points={activePts} color="#22d3ee" lineWidth={4} />
      )}

      {/* Vertical line from burst to ground */}
      {burstPt && !isAnim && (
        <Line
          points={[burstPt.pos, new THREE.Vector3(burstPt.pos.x, 0, burstPt.pos.z)]}
          color="#eab308"
          lineWidth={1}
          transparent
          opacity={0.4}
          dashed
          dashSize={0.1}
          gapSize={0.05}
        />
      )}

      {/* Launch sphere */}
      {launchPt && (
        <mesh position={launchPt.pos}>
          <sphereGeometry args={[0.06, 16, 16]} />
          <meshStandardMaterial color="#10b981" emissive="#10b981" emissiveIntensity={0.5} />
        </mesh>
      )}

      {/* Burst sphere */}
      {burstPt && !isAnim && (
        <mesh position={burstPt.pos}>
          <sphereGeometry args={[0.07, 16, 16]} />
          <meshStandardMaterial color="#eab308" emissive="#eab308" emissiveIntensity={0.5} />
        </mesh>
      )}

      {/* Landing sphere */}
      {landingPt && !isAnim && (
        <mesh position={landingPt.pos}>
          <sphereGeometry args={[0.07, 16, 16]} />
          <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={0.5} />
        </mesh>
      )}

      {/* Labels */}
      {launchPt && !isAnim && (
        <Text position={[launchPt.pos.x, launchPt.pos.y + 0.15, launchPt.pos.z]} fontSize={0.13} color="#10b981" anchorX="center" anchorY="bottom">LAUNCH</Text>
      )}
      {burstPt && !isAnim && (
        <Text position={[burstPt.pos.x, burstPt.pos.y + 0.15, burstPt.pos.z]} fontSize={0.13} color="#eab308" anchorX="center" anchorY="bottom">{`BURST ${(burstPt.alt / 1000).toFixed(0)}km`}</Text>
      )}
      {landingPt && !isAnim && (
        <Text position={[landingPt.pos.x, landingPt.pos.y + 0.15, landingPt.pos.z]} fontSize={0.13} color="#ef4444" anchorX="center" anchorY="bottom">LANDING</Text>
      )}

      {/* Altitude scale axis */}
      {vScale !== undefined && altTicks.map(km => {
        const y = (km / 1000) * vScale * 1000 / 1000 * vScale;
        // simpler: y = km * (vScale / (maxAlt))... 
        // vScale = 3/maxAlt, so y = km * 3 / maxAlt
        const worldY = km * 3 / maxAlt;
        return (
          <group key={km}>
            <Line points={[new THREE.Vector3(-5, worldY, -5), new THREE.Vector3(-4.8, worldY, -5)]} color="#374151" lineWidth={1} />
            <Text position={[-4.6, worldY, -5]} fontSize={0.12} color="#6b7280" anchorX="left" anchorY="middle">{km}km</Text>
          </group>
        );
      })}
      <Line points={[new THREE.Vector3(-5, 0, -5), new THREE.Vector3(-5, 3.2, -5)]} color="#374151" lineWidth={1} transparent opacity={0.5} />
      <Text position={[-5.1, 1.6, -5]} fontSize={0.1} color="#4b5563" anchorX="center" anchorY="middle" rotation={[0, 0, Math.PI / 2]}>ALTITUDE</Text>

      {/* Animated balloon */}
      {isAnim && curPt && (
        <>
          {/* Glow sphere */}
          <mesh position={curPt.pos}>
            <sphereGeometry args={[0.1, 16, 16]} />
            <meshStandardMaterial color="#22d3ee" emissive="#22d3ee" emissiveIntensity={1.5} transparent opacity={0.9} />
          </mesh>
          {/* Outer glow */}
          <mesh position={curPt.pos}>
            <sphereGeometry args={[0.18, 16, 16]} />
            <meshStandardMaterial color="#22d3ee" emissive="#22d3ee" emissiveIntensity={0.3} transparent opacity={0.2} />
          </mesh>
          {/* Vertical line to ground */}
          <Line
            points={[curPt.pos, new THREE.Vector3(curPt.pos.x, 0, curPt.pos.z)]}
            color="#22d3ee"
            lineWidth={1}
            transparent
            opacity={0.3}
            dashed
            dashSize={0.08}
            gapSize={0.04}
          />
          {/* HTML overlay with stats */}
          {curTraj && (
            <Html position={[curPt.pos.x + 0.2, curPt.pos.y + 0.2, curPt.pos.z]} style={{ pointerEvents: "none" }}>
              <div className="bg-black/80 border border-cyan-500/40 rounded-md px-2.5 py-1.5 text-[10px] font-mono text-cyan-300 whitespace-nowrap shadow-lg">
                <div className="text-cyan-400 font-bold text-[11px] mb-0.5">
                  {curTraj.phase === "ascent" ? "↑ ASCENT" : "↓ DESCENT"}
                </div>
                <div>ALT: <span className="text-white">{(curTraj.altitude / 1000).toFixed(2)} km</span></div>
                <div>WIND: <span className="text-white">{curTraj.wind_speed.toFixed(1)} m/s</span></div>
                <div>LAT: <span className="text-white">{curTraj.latitude.toFixed(3)}°</span></div>
                <div>LNG: <span className="text-white">{curTraj.longitude.toFixed(3)}°</span></div>
              </div>
            </Html>
          )}
        </>
      )}
    </>
  );
}

// ── Export ─────────────────────────────────────────────────────────────────────

export default function Route3D({ trajectory, animFrame, onClose }: Route3DProps) {
  const controlsRef = useRef<any>(null);

  const resetCamera = () => {
    if (controlsRef.current) {
      controlsRef.current.reset();
    }
  };

  return (
    <div className="fixed inset-0 z-[9000] bg-black/95 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border/50 bg-black/60 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
          <span className="font-mono font-bold text-sm tracking-widest text-cyan-300">3D TRAJECTORY VIEW</span>
          <span className="text-[10px] font-mono text-muted-foreground px-2 py-0.5 border border-border/50 rounded">
            {trajectory.length} data points
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground">드래그: 회전 · 스크롤: 줌 · 우클릭: 이동</span>
          <button
            onClick={resetCamera}
            className="p-1.5 rounded border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
            title="카메라 초기화"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded border border-border/50 text-muted-foreground hover:text-red-400 hover:border-red-400/50 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 px-6 py-2 border-b border-border/30 text-[10px] font-mono text-muted-foreground">
        <div className="flex items-center gap-1.5"><div className="w-6 h-0.5 bg-[#0ea5e9]" /><span>ASCENT</span></div>
        <div className="flex items-center gap-1.5"><div className="w-6 h-0.5 bg-[#f97316]" /><span>DESCENT</span></div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-[#10b981]" /><span>LAUNCH</span></div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-[#eab308]" /><span>BURST</span></div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-[#ef4444]" /><span>LANDING</span></div>
        <div className="flex items-center gap-1.5"><div className="w-6 h-0.5 bg-[#06b6d4] opacity-40" /><span>GROUND TRACK</span></div>
      </div>

      {/* 3D Canvas */}
      <div className="flex-1">
        <Canvas
          camera={{ position: [6, 5, 8], fov: 45 }}
          gl={{ antialias: true }}
          style={{ background: "radial-gradient(ellipse at center, #0a1628 0%, #020409 100%)" }}
        >
          <Suspense fallback={null}>
            <Scene trajectory={trajectory} animFrame={animFrame} />
            <OrbitControls
              ref={controlsRef}
              enableDamping
              dampingFactor={0.05}
              minDistance={2}
              maxDistance={25}
              maxPolarAngle={Math.PI / 2}
            />
          </Suspense>
        </Canvas>
      </div>
    </div>
  );
}
