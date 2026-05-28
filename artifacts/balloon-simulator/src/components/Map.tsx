/**
 * BalloonMap
 *
 * 2D mode  → Leaflet (raster tiles, no WebGL)
 * 3D mode  → Three.js canvas (tiles as textures, trajectory floats at altitude)
 *
 * Only ONE canvas is active at a time to avoid WebGL context conflicts.
 */
import { useEffect, useRef, useMemo, useState, Suspense } from "react";

// ── 2D (Leaflet) ──────────────────────────────────────────────────────────────
import { MapContainer, TileLayer, Polyline, Marker, Popup, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";

// ── 3D (Three.js) ─────────────────────────────────────────────────────────────
import { Canvas, useLoader } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";

import type { SimulationResult, TrajectoryPoint } from "@workspace/api-client-react";
import type { FlightCase } from "@workspace/api-client-react";

// ═══════════════════════════════════════════════════════════════════════════════
//  SHARED TYPES / CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const CASE_COLORS = ["#22c55e", "#3b82f6", "#f59e0b"] as const;
const ZOOM        = 7;
// 1 tile at zoom-7, Korea latitude (~37.5°N) ≈ 248 km east-west
// Alt exaggeration so 40 km balloon altitude ≈ 30% of tile width visually
const ALT_SCALE   = 8 / 248; // Three.js Y units per km

interface MapProps {
  simulationResult: SimulationResult | null;
  launchPos: { lat: number; lng: number };
  animFrame?: number;
  clickMode?: "launch" | "target" | null;
  targetPos?: { lat: number; lng: number } | null;
  onMapClick?: (lat: number, lng: number) => void;
  planCases?: FlightCase[] | null;
  selectedCaseIdx?: number | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2-D — LEAFLET IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

delete (L.Icon.Default.prototype as any)._getIconUrl;

const mkIcon = (color: string, glow = false, size = 12) =>
  new L.DivIcon({
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:2px solid #fff;box-shadow:${glow ? `0 0 10px 2px ${color}` : "0 0 4px rgba(0,0,0,.5)"};"></div>`,
    className: "custom-leaflet-icon",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

const launchIcon  = mkIcon("#10b981");
const burstIcon   = mkIcon("#eab308");
const landingIcon = mkIcon("#ef4444");
const balloonIcon = mkIcon("#06b6d4", true);
const targetIcon  = new L.DivIcon({
  html: `<div style="position:relative;width:32px;height:32px;"><div style="position:absolute;inset:0;border-radius:50%;border:3px solid #a855f7;box-shadow:0 0 12px 3px #a855f7;"></div><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:8px;height:8px;border-radius:50%;background:#a855f7;"></div></div>`,
  className: "custom-leaflet-icon",
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

function BoundsUpdater({ result }: { result: SimulationResult | null }) {
  const map = useMap();
  useEffect(() => {
    if (result?.trajectory.length)
      map.fitBounds(L.latLngBounds(result.trajectory.map(p => [p.latitude, p.longitude])), { padding: [50, 50] });
  }, [result, map]);
  return null;
}

function PlanBounds({ cases, launchPos, targetPos }: {
  cases: FlightCase[] | null | undefined;
  launchPos: { lat: number; lng: number };
  targetPos: { lat: number; lng: number } | null | undefined;
}) {
  const map = useMap();
  useEffect(() => {
    if (!cases?.length) {
      if (targetPos) map.fitBounds(L.latLngBounds([[launchPos.lat, launchPos.lng], [targetPos.lat, targetPos.lng]]), { padding: [60, 60] });
      return;
    }
    const pts: [number, number][] = [
      [launchPos.lat, launchPos.lng],
      ...(targetPos ? [[targetPos.lat, targetPos.lng] as [number, number]] : []),
      ...cases.flatMap(c => c.simulation.trajectory.map(p => [p.latitude, p.longitude] as [number, number])),
    ];
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [50, 50] });
  }, [cases, targetPos]);
  return null;
}

function ClickHandler({ onMapClick, clickMode }: { onMapClick?: (lat: number, lng: number) => void; clickMode?: "launch" | "target" | null }) {
  const map = useMapEvents({
    click(e) { if (clickMode && onMapClick) onMapClick(e.latlng.lat, e.latlng.lng); },
  });
  useEffect(() => {
    map.getContainer().style.cursor = clickMode ? "crosshair" : "";
    return () => { map.getContainer().style.cursor = ""; };
  }, [clickMode, map]);
  return null;
}

function LeafletMap({
  simulationResult, launchPos, animFrame,
  clickMode, targetPos, onMapClick, planCases, selectedCaseIdx,
}: MapProps) {
  const traj        = simulationResult?.trajectory ?? [];
  const ascentPts   = traj.filter(p => p.phase === "ascent").map(p => [p.latitude, p.longitude] as [number, number]);
  const descentPts  = traj.filter(p => p.phase === "descent").map(p => [p.latitude, p.longitude] as [number, number]);
  const burstPt     = traj.find(p => p.phase === "descent");
  const landingPt   = simulationResult?.landing;
  const isAnim      = animFrame !== undefined && animFrame >= 0 && animFrame < traj.length;
  const frame       = isAnim ? Math.min(animFrame!, traj.length - 1) : -1;
  const activePts   = isAnim ? traj.slice(0, frame + 1).map(p => [p.latitude, p.longitude] as [number, number]) : [];
  const futurePts   = isAnim ? traj.slice(frame).map(p => [p.latitude, p.longitude] as [number, number]) : [];
  const curPos      = isAnim && frame >= 0 ? [traj[frame].latitude, traj[frame].longitude] as [number, number] : null;
  const isPlanMode  = !simulationResult && (planCases !== undefined || targetPos !== undefined);

  return (
    <MapContainer center={[launchPos.lat, launchPos.lng]} zoom={7} style={{ height: "100%", width: "100%" }} className="z-0">
      <TileLayer
        attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />
      <ClickHandler onMapClick={onMapClick} clickMode={clickMode} />
      {simulationResult && <BoundsUpdater result={simulationResult} />}
      {isPlanMode && <PlanBounds cases={planCases} launchPos={launchPos} targetPos={targetPos} />}

      <Marker position={[launchPos.lat, launchPos.lng]} icon={launchIcon}>
        <Tooltip permanent direction="top" offset={[0, -10]}>출발지</Tooltip>
      </Marker>

      {targetPos && (
        <Marker position={[targetPos.lat, targetPos.lng]} icon={targetIcon}>
          <Tooltip permanent direction="top" offset={[0, -20]}>목적지</Tooltip>
        </Marker>
      )}

      {isPlanMode && planCases?.map((fc, idx) => {
        const col  = CASE_COLORS[idx % CASE_COLORS.length];
        const sel  = selectedCaseIdx === idx;
        const op   = selectedCaseIdx == null || sel ? 1 : 0.3;
        const t    = fc.simulation.trajectory;
        return (
          <span key={idx}>
            <Polyline positions={t.filter(p => p.phase === "ascent").map(p => [p.latitude, p.longitude] as [number, number])} color={col} weight={sel ? 3 : 2} opacity={op} dashArray="5,8" />
            <Polyline positions={t.filter(p => p.phase === "descent").map(p => [p.latitude, p.longitude] as [number, number])} color={col} weight={sel ? 3 : 2} opacity={op} />
            <Marker position={[fc.simulation.landing.latitude, fc.simulation.landing.longitude]} icon={mkIcon(col, sel, sel ? 14 : 10)} opacity={op}>
              <Popup><div className="text-xs"><strong>케이스 {fc.case_number}</strong><br />{fc.label}<br />목적지까지: {fc.distance_to_target_km.toFixed(1)} km</div></Popup>
            </Marker>
          </span>
        );
      })}

      {simulationResult && !isAnim && (
        <>
          <Polyline positions={ascentPts}  color="#0ea5e9" weight={3} dashArray="5,10" />
          <Polyline positions={descentPts} color="#f97316" weight={3} dashArray="5,10" />
          {ascentPts[0]  && <Marker position={ascentPts[0]}  icon={launchIcon}><Popup>Launch Site</Popup></Marker>}
          {burstPt       && <Marker position={[burstPt.latitude, burstPt.longitude]} icon={burstIcon}><Popup>Burst {(burstPt.altitude / 1000).toFixed(1)} km</Popup></Marker>}
          {landingPt     && <Marker position={[landingPt.latitude, landingPt.longitude]} icon={landingIcon}><Popup>Landing Site</Popup></Marker>}
        </>
      )}

      {simulationResult && isAnim && curPos && (
        <>
          <Polyline positions={activePts} color="#0ea5e9" weight={4} />
          <Polyline positions={futurePts} color="#ffffff" weight={2} opacity={0.2} dashArray="4,8" />
          {ascentPts[0] && <Marker position={ascentPts[0]} icon={launchIcon} />}
          <Marker position={curPos} icon={balloonIcon}>
            <Tooltip permanent direction="top" offset={[0, -10]}>
              Alt: {(traj[frame].altitude / 1000).toFixed(1)} km
            </Tooltip>
          </Marker>
        </>
      )}
    </MapContainer>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  3-D — THREE.JS IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

function lngLatToTileFloat(lng: number, lat: number): [number, number] {
  const n  = Math.pow(2, ZOOM);
  const tx = ((lng + 180) / 360) * n;
  const lr = (lat * Math.PI) / 180;
  const ty = ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n;
  return [tx, ty];
}

function tileFloatToLngLat(tx: number, ty: number): [number, number] {
  const n   = Math.pow(2, ZOOM);
  const lng = (tx / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return [lng, lat];
}

function toWorld(lng: number, lat: number, alt_km: number, ox: number, oy: number): THREE.Vector3 {
  const [tx, ty] = lngLatToTileFloat(lng, lat);
  return new THREE.Vector3(tx - ox, alt_km * ALT_SCALE, ty - oy);
}

function tileUrl(x: number, y: number): string {
  return `https://${"abc"[(Math.abs(x) + Math.abs(y)) % 3]}.basemaps.cartocdn.com/dark_all/${ZOOM}/${x}/${y}.png`;
}

function MapTile3D({ tx, ty, ox, oy }: { tx: number; ty: number; ox: number; oy: number }) {
  const tex = useLoader(THREE.TextureLoader, tileUrl(tx, ty));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter  = THREE.LinearFilter;
  const wx = tx - ox + 0.5;
  const wz = ty - oy + 0.5;
  return (
    <mesh position={[wx, 0, wz]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial map={tex} />
    </mesh>
  );
}

function TileGrid3D({ ox, oy }: { ox: number; oy: number }) {
  const bx = Math.floor(ox);
  const by = Math.floor(oy);
  const tiles: { tx: number; ty: number }[] = [];
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -4; dx <= 4; dx++)
      tiles.push({ tx: bx + dx, ty: by + dy });
  return (
    <>
      {tiles.map(({ tx, ty }) => (
        <Suspense key={`${tx}:${ty}`} fallback={null}>
          <MapTile3D tx={tx} ty={ty} ox={ox} oy={oy} />
        </Suspense>
      ))}
    </>
  );
}

function Dot3D({ pos, color, size = 0.07, glow = false, label }: { pos: THREE.Vector3; color: string; size?: number; glow?: boolean; label?: string }) {
  const c = new THREE.Color(color);
  return (
    <group position={pos}>
      <mesh>
        <sphereGeometry args={[size, 16, 16]} />
        <meshStandardMaterial color={c} emissive={c} emissiveIntensity={glow ? 1 : 0.4} />
      </mesh>
      {glow && (
        <mesh>
          <sphereGeometry args={[size * 2, 10, 10]} />
          <meshStandardMaterial color={c} transparent opacity={0.12} />
        </mesh>
      )}
      {label && (
        <Html center position={[0, size + 0.12, 0]} style={{ pointerEvents: "none" }}>
          <div style={{ fontSize: 10, fontFamily: "monospace", fontWeight: "bold", color, background: "rgba(0,0,0,0.8)", padding: "1px 6px", borderRadius: 4, whiteSpace: "nowrap", border: `1px solid ${color}50` }}>
            {label}
          </div>
        </Html>
      )}
    </group>
  );
}

function Scene3D({
  ox, oy,
  simulationResult, launchPos, animFrame,
  clickMode, targetPos, onMapClick, planCases, selectedCaseIdx,
}: MapProps & { ox: number; oy: number }) {
  const traj       = simulationResult?.trajectory ?? [];
  const isAnim     = animFrame !== undefined && animFrame >= 0 && animFrame < traj.length;
  const frame      = isAnim ? Math.min(animFrame!, traj.length - 1) : -1;

  const allPts     = useMemo(() => traj.map(p => toWorld(p.longitude, p.latitude, p.altitude / 1000, ox, oy)), [traj, ox, oy]);
  const ascentPts  = useMemo(() => allPts.filter((_, i) => traj[i]?.phase === "ascent"), [allPts, traj]);
  const descentPts = useMemo(() => allPts.filter((_, i) => traj[i]?.phase === "descent"), [allPts, traj]);

  const burstIdx = useMemo(() => traj.findIndex(p => p.phase === "descent"), [traj]);
  const burstW   = burstIdx >= 0 ? allPts[burstIdx] : null;
  const launchW  = useMemo(() => toWorld(launchPos.lng, launchPos.lat, 0, ox, oy), [launchPos, ox, oy]);
  const landingW = simulationResult
    ? toWorld(simulationResult.landing.longitude, simulationResult.landing.latitude, 0, ox, oy)
    : null;

  const activePts  = isAnim ? allPts.slice(0, frame + 1) : [];
  const futurePts  = isAnim ? allPts.slice(frame) : [];
  const curPt      = isAnim && frame >= 0 ? allPts[frame] : null;
  const curTraj    = isAnim && frame >= 0 ? traj[frame] : null;

  const targetW = targetPos ? toWorld(targetPos.lng, targetPos.lat, 0, ox, oy) : null;

  const caseWorlds = useMemo(() =>
    (planCases ?? []).map((fc, idx) => {
      const t = fc.simulation.trajectory;
      const w = t.map(p => toWorld(p.longitude, p.latitude, p.altitude / 1000, ox, oy));
      return {
        idx, color: CASE_COLORS[idx % CASE_COLORS.length],
        ap: w.filter((_, i) => t[i]?.phase === "ascent"),
        dp: w.filter((_, i) => t[i]?.phase === "descent"),
        lw: toWorld(fc.simulation.landing.longitude, fc.simulation.landing.latitude, 0, ox, oy),
        sel: selectedCaseIdx === idx,
        op: selectedCaseIdx == null || selectedCaseIdx === idx ? 1 : 0.25,
        label: `Case ${fc.case_number}`,
      };
    }),
    [planCases, selectedCaseIdx, ox, oy]
  );

  return (
    <>
      <ambientLight intensity={0.9} />
      <directionalLight position={[3, 8, 4]} intensity={0.5} />

      <TileGrid3D ox={ox} oy={oy} />

      {/* Click plane (invisible ground) */}
      {clickMode && onMapClick && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} onPointerDown={e => {
          e.stopPropagation();
          const [lng, lat] = tileFloatToLngLat(e.point.x + ox, e.point.z + oy);
          onMapClick(lat, lng);
        }}>
          <planeGeometry args={[100, 100]} />
          <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Launch */}
      <Dot3D pos={launchW} color="#10b981" label="출발지" />

      {/* Target */}
      {targetW && <Dot3D pos={targetW} color="#a855f7" label="목적지" />}

      {/* Simulation static */}
      {simulationResult && !isAnim && ascentPts.length >= 2 && (
        <Line points={ascentPts} color="#0ea5e9" lineWidth={3} />
      )}
      {simulationResult && !isAnim && descentPts.length >= 2 && (
        <Line points={descentPts} color="#f97316" lineWidth={3} />
      )}
      {simulationResult && !isAnim && burstW && (
        <>
          <Dot3D pos={burstW} color="#eab308" label={burstIdx >= 0 ? `Burst ${(traj[burstIdx].altitude / 1000).toFixed(1)}km` : "Burst"} />
          <Line points={[burstW, new THREE.Vector3(burstW.x, 0.005, burstW.z)]} color="#eab308" lineWidth={1} transparent opacity={0.3} />
        </>
      )}
      {simulationResult && !isAnim && landingW && (
        <Dot3D pos={landingW} color="#ef4444" label="Landing" />
      )}

      {/* Animation */}
      {isAnim && activePts.length >= 2 && <Line points={activePts} color="#22d3ee" lineWidth={4} />}
      {isAnim && futurePts.length >= 2 && <Line points={futurePts} color="#ffffff" lineWidth={2} transparent opacity={0.2} />}
      {isAnim && curPt && (
        <>
          <Dot3D pos={curPt} color="#22d3ee" size={0.1} glow />
          <Line points={[curPt, new THREE.Vector3(curPt.x, 0.005, curPt.z)]} color="#22d3ee" lineWidth={1} transparent opacity={0.3} />
          {curTraj && (
            <Html position={curPt} style={{ pointerEvents: "none" }}>
              <div style={{ transform: "translate(14px,-18px)", background: "rgba(0,0,0,0.85)", border: "1px solid #22d3ee50", borderRadius: 6, padding: "3px 8px", fontSize: 10, fontFamily: "monospace", color: "#22d3ee", whiteSpace: "nowrap", lineHeight: 1.7 }}>
                <div style={{ color: "#fff", fontWeight: "bold" }}>{curTraj.phase === "ascent" ? "↑ ASCENT" : "↓ DESCENT"}</div>
                <div>ALT <span style={{ color: "#fff" }}>{(curTraj.altitude / 1000).toFixed(2)} km</span></div>
                <div>WIND <span style={{ color: "#fff" }}>{curTraj.wind_speed.toFixed(1)} m/s</span></div>
              </div>
            </Html>
          )}
        </>
      )}

      {/* Plan cases */}
      {caseWorlds.map(({ idx, color, ap, dp, lw, sel, op, label }) => (
        <group key={idx}>
          {ap.length >= 2 && <Line points={ap} color={color} lineWidth={sel ? 3 : 2} transparent opacity={op} />}
          {dp.length >= 2 && <Line points={dp} color={color} lineWidth={sel ? 3 : 2} transparent opacity={op} />}
          <Dot3D pos={lw} color={color} size={sel ? 0.09 : 0.06} label={label} />
        </group>
      ))}

      <OrbitControls
        enableDamping
        dampingFactor={0.07}
        maxPolarAngle={Math.PI / 2 - 0.02}
        minDistance={0.3}
        maxDistance={25}
        screenSpacePanning
      />
    </>
  );
}

function ThreeMap(props: MapProps) {
  const { launchPos } = props;
  const [ox, oy] = useMemo(
    () => lngLatToTileFloat(launchPos.lng, launchPos.lat),
    [launchPos.lat, launchPos.lng]
  );

  return (
    <Canvas
      camera={{ position: [1.5, 6, 8], fov: 45, near: 0.01, far: 500 }}
      gl={{ antialias: false, powerPreference: "default" }}
      style={{ width: "100%", height: "100%", background: "#050a0f" }}
    >
      <Scene3D {...props} ox={ox} oy={oy} />
    </Canvas>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPORTED COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function BalloonMap(props: MapProps) {
  const [is3D, setIs3D] = useState(false);
  const { clickMode } = props;

  return (
    <div className="h-full w-full rounded-lg overflow-hidden border border-border bg-muted/20 relative z-0">
      {/* Map area — only ONE renderer mounted at a time */}
      {is3D ? <ThreeMap {...props} /> : <LeafletMap {...props} />}

      {/* Status badge */}
      <div className="absolute top-4 left-4 z-[400] pointer-events-none">
        <div className="px-3 py-1.5 bg-background/80 backdrop-blur border border-border rounded-md shadow-lg text-xs font-mono tracking-wider text-muted-foreground flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          {clickMode === "launch" ? "출발지 클릭하세요" :
           clickMode === "target" ? "목적지 클릭하세요" :
           "SYSTEM ONLINE"}
        </div>
      </div>

      {/* 2D / 3D toggle */}
      <div className={`absolute bottom-8 z-[400] ${is3D ? "left-4" : "left-12"}`}>
        <button
          onClick={() => setIs3D(v => !v)}
          className={`px-3 py-1.5 rounded-md text-xs font-mono font-bold border shadow-lg backdrop-blur transition-all ${
            is3D
              ? "bg-cyan-500/20 border-cyan-500/60 text-cyan-300 hover:bg-cyan-500/30"
              : "bg-black/70 border-border/60 text-muted-foreground hover:bg-white/10 hover:text-foreground"
          }`}
        >
          {is3D ? "2D ▬" : "3D ▲"}
        </button>
      </div>
    </div>
  );
}
