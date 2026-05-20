import React, { useEffect, useRef } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import type { SimulationResult } from "@workspace/api-client-react";

// Fix leaflet icons since they sometimes break in react-leaflet without proper imports
delete (L.Icon.Default.prototype as any)._getIconUrl;

const createIcon = (color: string) => {
  return new L.DivIcon({
    html: `<div style="background-color: ${color}; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.5);"></div>`,
    className: "custom-leaflet-icon",
    iconSize: [12, 12],
    iconAnchor: [6, 6]
  });
};

const launchIcon = createIcon("#10b981"); // green-500
const burstIcon = createIcon("#eab308"); // yellow-500
const landingIcon = createIcon("#ef4444"); // red-500

interface MapProps {
  simulationResult: SimulationResult | null;
  launchPos: { lat: number; lng: number };
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

export function BalloonMap({ simulationResult, launchPos }: MapProps) {
  const ascentPoints = simulationResult?.trajectory
    .filter(pt => pt.phase === "ascent")
    .map(pt => [pt.latitude, pt.longitude] as [number, number]) || [];
    
  const descentPoints = simulationResult?.trajectory
    .filter(pt => pt.phase === "descent")
    .map(pt => [pt.latitude, pt.longitude] as [number, number]) || [];
    
  const burstPoint = simulationResult?.trajectory.find(pt => pt.phase === "descent");
  const landingPoint = simulationResult?.landing;

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

        {simulationResult && (
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
