import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import type { SimulationResult } from "@workspace/api-client-react";

// Fix leaflet icons since they sometimes break in react-leaflet without proper imports
delete (L.Icon.Default.prototype as any)._getIconUrl;

const createIcon = (color: string, glow: boolean = false) => {
  return new L.DivIcon({
    html: `<div style="background-color: ${color}; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: ${glow ? `0 0 10px 2px ${color}` : '0 0 4px rgba(0,0,0,0.5)'};"></div>`,
    className: "custom-leaflet-icon",
    iconSize: [12, 12],
    iconAnchor: [6, 6]
  });
};

const launchIcon = createIcon("#10b981"); // green-500
const burstIcon = createIcon("#eab308"); // yellow-500
const landingIcon = createIcon("#ef4444"); // red-500
const balloonIcon = createIcon("#06b6d4", true); // cyan-500 with glow

interface MapProps {
  simulationResult: SimulationResult | null;
  launchPos: { lat: number; lng: number };
  animFrame?: number;
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

export function BalloonMap({ simulationResult, launchPos, animFrame }: MapProps) {
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
        
        {simulationResult && <MapBoundsUpdater result={simulationResult} />}

        {!simulationResult && (
          <Marker position={[launchPos.lat, launchPos.lng]} icon={launchIcon}>
            <Tooltip permanent direction="top" offset={[0, -10]}>Launch Site</Tooltip>
          </Marker>
        )}

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
          SYSTEM ONLINE
        </div>
      </div>
    </div>
  );
}
