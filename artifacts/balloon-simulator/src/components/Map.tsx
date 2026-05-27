import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { SimulationResult } from "@workspace/api-client-react";
import type { FlightCase } from "@workspace/api-client-react";

// Fix leaflet icons since they sometimes break in react-leaflet without proper imports
delete (L.Icon.Default.prototype as any)._getIconUrl;

const createIcon = (color: string, glow: boolean = false, size: number = 12) => {
  return new L.DivIcon({
    html: `<div style="background-color: ${color}; width: ${size}px; height: ${size}px; border-radius: 50%; border: 2px solid white; box-shadow: ${glow ? `0 0 10px 2px ${color}` : '0 0 4px rgba(0,0,0,0.5)'};"></div>`,
    className: "custom-leaflet-icon",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
};

const createTargetIcon = () => {
  return new L.DivIcon({
    html: `<div style="position:relative;width:32px;height:32px;">
      <div style="position:absolute;inset:0;border-radius:50%;border:3px solid #a855f7;box-shadow:0 0 12px 3px #a855f7;animation:none;"></div>
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:8px;height:8px;border-radius:50%;background:#a855f7;"></div>
    </div>`,
    className: "custom-leaflet-icon",
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });
};

const launchIcon  = createIcon("#10b981"); // green-500
const burstIcon   = createIcon("#eab308"); // yellow-500
const landingIcon = createIcon("#ef4444"); // red-500
const balloonIcon = createIcon("#06b6d4", true); // cyan-500 with glow
const targetIcon  = createTargetIcon();

const CASE_COLORS = ["#22c55e", "#3b82f6", "#f59e0b"] as const;

interface MapProps {
  simulationResult: SimulationResult | null;
  launchPos: { lat: number; lng: number };
  animFrame?: number;
  // Planning mode props
  clickMode?: "launch" | "target" | null;
  targetPos?: { lat: number; lng: number } | null;
  onMapClick?: (lat: number, lng: number) => void;
  planCases?: FlightCase[] | null;
  selectedCaseIdx?: number | null;
}

function MapBoundsUpdater({ result }: { result: SimulationResult | null }) {
  const map = useMap();
  
  useEffect(() => {
    if (result && result.trajectory.length > 0) {
      const bounds = L.latLngBounds(
        result.trajectory.map(pt => [pt.latitude, pt.longitude])
      );
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [result, map]);

  return null;
}

function PlanBoundsUpdater({ cases, launchPos, targetPos }: {
  cases: FlightCase[] | null | undefined;
  launchPos: { lat: number; lng: number };
  targetPos: { lat: number; lng: number } | null | undefined;
}) {
  const map = useMap();

  useEffect(() => {
    if (!cases || cases.length === 0) {
      if (targetPos) {
        const pts: [number, number][] = [
          [launchPos.lat, launchPos.lng],
          [targetPos.lat, targetPos.lng],
        ];
        map.fitBounds(L.latLngBounds(pts), { padding: [60, 60] });
      }
      return;
    }
    const pts: [number, number][] = [
      [launchPos.lat, launchPos.lng],
      ...(targetPos ? [[targetPos.lat, targetPos.lng] as [number, number]] : []),
      ...cases.flatMap(c => c.simulation.trajectory.map(pt => [pt.latitude, pt.longitude] as [number, number])),
    ];
    if (pts.length > 0) {
      map.fitBounds(L.latLngBounds(pts), { padding: [50, 50] });
    }
  }, [cases, targetPos]);

  return null;
}

function MapClickHandler({ onMapClick, clickMode }: {
  onMapClick?: (lat: number, lng: number) => void;
  clickMode?: "launch" | "target" | null;
}) {
  const map = useMapEvents({
    click(e) {
      if (clickMode && onMapClick) {
        onMapClick(e.latlng.lat, e.latlng.lng);
      }
    },
  });

  useEffect(() => {
    const container = map.getContainer();
    if (clickMode) {
      container.style.cursor = "crosshair";
    } else {
      container.style.cursor = "";
    }
    return () => {
      container.style.cursor = "";
    };
  }, [clickMode, map]);

  return null;
}

export function BalloonMap({
  simulationResult,
  launchPos,
  animFrame,
  clickMode,
  targetPos,
  onMapClick,
  planCases,
  selectedCaseIdx,
}: MapProps) {
  const trajectory = simulationResult?.trajectory || [];
  
  const ascentPoints = trajectory
    .filter(pt => pt.phase === "ascent")
    .map(pt => [pt.latitude, pt.longitude] as [number, number]);
    
  const descentPoints = trajectory
    .filter(pt => pt.phase === "descent")
    .map(pt => [pt.latitude, pt.longitude] as [number, number]);
    
  const burstPoint = trajectory.find(pt => pt.phase === "descent");
  const landingPoint = simulationResult?.landing;

  // Animation logic
  const isAnimating = animFrame !== undefined && animFrame >= 0 && animFrame < trajectory.length;
  
  let activePath: [number, number][] = [];
  let futurePath: [number, number][] = [];
  let currentPos: [number, number] | null = null;
  
  if (isAnimating && trajectory.length > 0) {
    const frame = Math.min(animFrame!, trajectory.length - 1);
    const activeTraj = trajectory.slice(0, frame + 1);
    activePath = activeTraj.map(pt => [pt.latitude, pt.longitude] as [number, number]);
    futurePath = trajectory.slice(frame).map(pt => [pt.latitude, pt.longitude] as [number, number]);
    currentPos = [trajectory[frame].latitude, trajectory[frame].longitude];
  }

  const isPlanMode = !simulationResult && (planCases !== undefined || targetPos !== undefined);

  return (
    <div className="h-full w-full rounded-lg overflow-hidden border border-border bg-muted/20 relative z-0">
      <MapContainer
        center={[launchPos.lat, launchPos.lng]}
        zoom={7}
        style={{ height: "100%", width: "100%" }}
        className="z-0"
      >
        <TileLayer
          attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />

        <MapClickHandler onMapClick={onMapClick} clickMode={clickMode} />
        
        {simulationResult && <MapBoundsUpdater result={simulationResult} />}

        {isPlanMode && (
          <PlanBoundsUpdater cases={planCases} launchPos={launchPos} targetPos={targetPos} />
        )}

        {/* Always show launch marker */}
        <Marker position={[launchPos.lat, launchPos.lng]} icon={launchIcon}>
          <Tooltip permanent direction="top" offset={[0, -10]}>출발지</Tooltip>
        </Marker>

        {/* Target marker in planning mode */}
        {targetPos && (
          <Marker position={[targetPos.lat, targetPos.lng]} icon={targetIcon}>
            <Tooltip permanent direction="top" offset={[0, -20]}>목적지</Tooltip>
          </Marker>
        )}

        {/* Plan case trajectories */}
        {isPlanMode && planCases && planCases.map((fc, idx) => {
          const color = CASE_COLORS[idx % CASE_COLORS.length];
          const isSelected = selectedCaseIdx === idx;
          const opacity = selectedCaseIdx === null || isSelected ? 1 : 0.3;
          const traj = fc.simulation.trajectory;
          const ascentPts = traj.filter(p => p.phase === "ascent").map(p => [p.latitude, p.longitude] as [number, number]);
          const descentPts = traj.filter(p => p.phase === "descent").map(p => [p.latitude, p.longitude] as [number, number]);
          const landPt = fc.simulation.landing;
          const landIcon = createIcon(color, isSelected, isSelected ? 14 : 10);

          return (
            <div key={idx}>
              <Polyline positions={ascentPts} color={color} weight={isSelected ? 3 : 2} opacity={opacity} dashArray="5,8" />
              <Polyline positions={descentPts} color={color} weight={isSelected ? 3 : 2} opacity={opacity} />
              <Marker position={[landPt.latitude, landPt.longitude]} icon={landIcon} opacity={opacity}>
                <Popup>
                  <div className="text-xs">
                    <strong>케이스 {fc.case_number}</strong><br />
                    {fc.label}<br />
                    목적지까지: {fc.distance_to_target_km.toFixed(1)} km
                  </div>
                </Popup>
              </Marker>
            </div>
          );
        })}

        {/* Simulation mode - full trajectory */}
        {simulationResult && !isAnimating && (
          <>
            <Polyline positions={ascentPoints} color="#0ea5e9" weight={3} dashArray="5, 10" />
            <Polyline positions={descentPoints} color="#f97316" weight={3} dashArray="5, 10" />

            {ascentPoints.length > 0 && (
              <Marker position={ascentPoints[0]} icon={launchIcon}>
                <Popup>Launch Site</Popup>
              </Marker>
            )}

            {burstPoint && (
              <Marker position={[burstPoint.latitude, burstPoint.longitude]} icon={burstIcon}>
                <Popup>Burst Point<br/>Alt: {(burstPoint.altitude / 1000).toFixed(1)} km</Popup>
              </Marker>
            )}

            {landingPoint && (
              <Marker position={[landingPoint.latitude, landingPoint.longitude]} icon={landingIcon}>
                <Popup>Landing Site</Popup>
              </Marker>
            )}
          </>
        )}

        {simulationResult && isAnimating && currentPos && (
          <>
            {/* Trail */}
            <Polyline positions={activePath} color="#0ea5e9" weight={4} />
            <Polyline positions={futurePath} color="#ffffff" weight={2} opacity={0.2} dashArray="4, 8" />

            {ascentPoints.length > 0 && (
              <Marker position={ascentPoints[0]} icon={launchIcon}>
                <Popup>Launch Site</Popup>
              </Marker>
            )}

            {burstPoint && animFrame >= trajectory.findIndex(pt => pt === burstPoint) && (
              <Marker position={[burstPoint.latitude, burstPoint.longitude]} icon={burstIcon}>
                <Popup>Burst Point<br/>Alt: {(burstPoint.altitude / 1000).toFixed(1)} km</Popup>
              </Marker>
            )}

            {landingPoint && animFrame >= trajectory.length - 1 && (
              <Marker position={[landingPoint.latitude, landingPoint.longitude]} icon={landingIcon}>
                <Popup>Landing Site</Popup>
              </Marker>
            )}

            {/* Balloon Marker */}
            <Marker position={currentPos} icon={balloonIcon}>
              <Tooltip permanent direction="top" offset={[0, -10]}>
                Alt: {(trajectory[animFrame].altitude / 1000).toFixed(1)} km
              </Tooltip>
            </Marker>
          </>
        )}
      </MapContainer>
      
      {/* Overlay status */}
      <div className="absolute top-4 left-4 z-[400] pointer-events-none">
        <div className="px-3 py-1.5 bg-background/80 backdrop-blur border border-border rounded-md shadow-lg text-xs font-mono tracking-wider text-muted-foreground flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          {clickMode === "launch" ? "출발지 클릭하세요" :
           clickMode === "target" ? "목적지 클릭하세요" :
           "SYSTEM ONLINE"}
        </div>
      </div>
    </div>
  );
}
