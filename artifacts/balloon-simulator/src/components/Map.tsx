import { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { SimulationResult } from "@workspace/api-client-react";
import type { FlightCase } from "@workspace/api-client-react";

const MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const CASE_COLORS = ["#22c55e", "#3b82f6", "#f59e0b"] as const;

// How much to exaggerate altitude so it's visible on a regional zoom level
// At zoom 7 (Korea scale), 1000m altitude ≈ too small to see as z-offset
// We exaggerate by a factor so the path visually floats above the map
const ALT_EXAGGERATION = 8;

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

// ─── GeoJSON helpers ──────────────────────────────────────────────────────────

function makeLineGeoJSON(
  points: { lat: number; lng: number; alt?: number }[]
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points.length < 2 ? [] : [{
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: points.map(p => [p.lng, p.lat, (p.alt ?? 0) * ALT_EXAGGERATION]),
      },
    }],
  };
}

function makePointGeoJSON(lat: number, lng: number, alt = 0): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [lng, lat, alt * ALT_EXAGGERATION] },
    }],
  };
}

function emptyGeoJSON(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

// ─── Marker helpers ───────────────────────────────────────────────────────────

function makeMarkerEl(color: string, size = 14, glow = false, label?: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `position:relative;display:flex;flex-direction:column;align-items:center;pointer-events:none;`;
  const dot = document.createElement("div");
  dot.style.cssText = `
    width:${size}px;height:${size}px;border-radius:50%;
    background:${color};border:2px solid #fff;
    box-shadow:${glow ? `0 0 10px 4px ${color}80` : `0 0 4px rgba(0,0,0,0.5)`};
  `;
  el.appendChild(dot);
  if (label) {
    const tag = document.createElement("div");
    tag.style.cssText = `
      margin-top:3px;font-size:10px;font-family:monospace;font-weight:bold;
      color:${color};background:rgba(0,0,0,0.7);padding:1px 5px;border-radius:4px;
      white-space:nowrap;pointer-events:none;border:1px solid ${color}40;
    `;
    tag.textContent = label;
    el.appendChild(tag);
  }
  return el;
}

function makeTargetEl(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `width:32px;height:32px;position:relative;pointer-events:none;`;
  el.innerHTML = `
    <div style="position:absolute;inset:0;border-radius:50%;border:3px solid #a855f7;box-shadow:0 0 12px 3px #a855f780;"></div>
    <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:8px;height:8px;border-radius:50%;background:#a855f7;"></div>
    <div style="position:absolute;top:50%;left:0;width:100%;height:1px;background:#a855f750;"></div>
    <div style="position:absolute;top:0;left:50%;width:1px;height:100%;background:#a855f750;"></div>
  `;
  return el;
}

// ─── Main component ───────────────────────────────────────────────────────────

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
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);
  const loadedRef    = useRef(false);
  const markersRef   = useRef<maplibregl.Marker[]>([]);
  const balloonRef   = useRef<maplibregl.Marker | null>(null);
  const launchRef    = useRef<maplibregl.Marker | null>(null);
  const [is3D, setIs3D] = useState(true);

  // ── Helpers to set source data safely ──────────────────────────────────────

  const setData = useCallback((id: string, data: GeoJSON.FeatureCollection) => {
    const src = mapRef.current?.getSource(id) as maplibregl.GeoJSONSource | undefined;
    src?.setData(data);
  }, []);

  const clearMarkers = useCallback(() => {
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
  }, []);

  // ── Initialize map ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [launchPos.lng, launchPos.lat],
      zoom: 7,
      pitch: 55,
      bearing: 15,
      canvasContextAttributes: { antialias: true },
    });
    mapRef.current = map;

    map.on("load", () => {
      loadedRef.current = true;

      // ── Simulation trajectory sources ──────────────────────────────────────
      const simSources: Record<string, GeoJSON.FeatureCollection> = {
        "ascent-src":      emptyGeoJSON(),
        "descent-src":     emptyGeoJSON(),
        "active-src":      emptyGeoJSON(),
        "future-src":      emptyGeoJSON(),
        "balloon-src":     emptyGeoJSON(),
      };

      // ── Plan case sources (3 sets) ─────────────────────────────────────────
      for (let i = 0; i < 3; i++) {
        simSources[`plan-ascent-${i}`]  = emptyGeoJSON();
        simSources[`plan-descent-${i}`] = emptyGeoJSON();
      }

      for (const [id, data] of Object.entries(simSources)) {
        map.addSource(id, { type: "geojson", data, lineMetrics: true });
      }

      // ── Layers ─────────────────────────────────────────────────────────────

      // Plan case lines
      for (let i = 0; i < 3; i++) {
        const color = CASE_COLORS[i];
        map.addLayer({ id: `plan-ascent-layer-${i}`,  type: "line", source: `plan-ascent-${i}`,  paint: { "line-color": color, "line-width": 2.5, "line-opacity": 1, "line-dasharray": [4, 6] } });
        map.addLayer({ id: `plan-descent-layer-${i}`, type: "line", source: `plan-descent-${i}`, paint: { "line-color": color, "line-width": 2.5, "line-opacity": 1 } });
      }

      // Simulation full path
      map.addLayer({ id: "ascent-layer",  type: "line", source: "ascent-src",  paint: { "line-color": "#0ea5e9", "line-width": 3, "line-opacity": 0.9, "line-dasharray": [5, 8] } });
      map.addLayer({ id: "descent-layer", type: "line", source: "descent-src", paint: { "line-color": "#f97316", "line-width": 3, "line-opacity": 0.9, "line-dasharray": [5, 8] } });

      // Animation trail
      map.addLayer({ id: "active-layer", type: "line", source: "active-src", paint: { "line-color": "#0ea5e9", "line-width": 4, "line-opacity": 1 } });
      map.addLayer({ id: "future-layer", type: "line", source: "future-src", paint: { "line-color": "#ffffff", "line-width": 2, "line-opacity": 0.2, "line-dasharray": [4, 8] } });
    });

    return () => {
      loadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── Toggle 3D/2D ───────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ pitch: is3D ? 55 : 0, bearing: is3D ? 15 : 0, duration: 600 });
  }, [is3D]);

  // ── Click handling ──────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handler = (e: maplibregl.MapMouseEvent) => {
      if (clickMode && onMapClick) onMapClick(e.lngLat.lat, e.lngLat.lng);
    };

    if (clickMode) {
      map.on("click", handler);
      map.getCanvas().style.cursor = "crosshair";
    } else {
      map.getCanvas().style.cursor = "";
    }

    return () => {
      map.off("click", handler);
      map.getCanvas().style.cursor = "";
    };
  }, [clickMode, onMapClick]);

  // ── Launch marker ───────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    launchRef.current?.remove();
    launchRef.current = new maplibregl.Marker({ element: makeMarkerEl("#10b981", 14, false, "출발지"), anchor: "bottom" })
      .setLngLat([launchPos.lng, launchPos.lat])
      .addTo(map);
    return () => { launchRef.current?.remove(); };
  }, [launchPos.lat, launchPos.lng]);

  // ── Target marker ───────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const markers: maplibregl.Marker[] = [];
    if (targetPos) {
      const m = new maplibregl.Marker({ element: makeTargetEl(), anchor: "center" })
        .setLngLat([targetPos.lng, targetPos.lat])
        .addTo(map);
      markers.push(m);
    }
    return () => markers.forEach(m => m.remove());
  }, [targetPos?.lat, targetPos?.lng]);

  // ── Simulation result: update trajectory lines + static markers ────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    clearMarkers();

    if (!simulationResult) {
      setData("ascent-src",  emptyGeoJSON());
      setData("descent-src", emptyGeoJSON());
      setData("active-src",  emptyGeoJSON());
      setData("future-src",  emptyGeoJSON());
      balloonRef.current?.remove();
      balloonRef.current = null;
      return;
    }

    const traj = simulationResult.trajectory;
    const asc  = traj.filter(p => p.phase === "ascent").map(p => ({ lat: p.latitude, lng: p.longitude, alt: p.altitude }));
    const desc = traj.filter(p => p.phase === "descent").map(p => ({ lat: p.latitude, lng: p.longitude, alt: p.altitude }));

    const isAnim = animFrame !== undefined && animFrame >= 0 && animFrame < traj.length;

    if (isAnim) {
      setData("ascent-src",  emptyGeoJSON());
      setData("descent-src", emptyGeoJSON());
    } else {
      setData("ascent-src",  makeLineGeoJSON(asc));
      setData("descent-src", makeLineGeoJSON(desc));
      setData("active-src",  emptyGeoJSON());
      setData("future-src",  emptyGeoJSON());

      // Static markers: burst, landing
      const burst = traj.find(p => p.phase === "descent");
      if (burst) {
        const m = new maplibregl.Marker({ element: makeMarkerEl("#eab308", 13, false, `Burst ${(burst.altitude / 1000).toFixed(1)}km`), anchor: "bottom" })
          .setLngLat([burst.longitude, burst.latitude])
          .addTo(map);
        markersRef.current.push(m);
      }
      const landing = simulationResult.landing;
      const lm = new maplibregl.Marker({ element: makeMarkerEl("#ef4444", 14, false, "Landing"), anchor: "bottom" })
        .setLngLat([landing.longitude, landing.latitude])
        .addTo(map);
      markersRef.current.push(lm);

      // Fit bounds
      const allPts = traj.map(p => [p.longitude, p.latitude] as [number, number]);
      if (allPts.length >= 2) {
        const bounds = allPts.reduce((b, p) => b.extend(p as [number, number]), new maplibregl.LngLatBounds(allPts[0], allPts[0]));
        map.fitBounds(bounds, { padding: 80, pitch: is3D ? 55 : 0, bearing: is3D ? 15 : 0, duration: 800 });
      }
    }
  }, [simulationResult, clearMarkers, setData]);

  // ── Animation frame: update trail + balloon marker ──────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !simulationResult) return;

    const traj = simulationResult.trajectory;
    const isAnim = animFrame !== undefined && animFrame >= 0 && animFrame < traj.length;
    if (!isAnim) return;

    const frame   = Math.min(animFrame!, traj.length - 1);
    const active  = traj.slice(0, frame + 1).map(p => ({ lat: p.latitude, lng: p.longitude, alt: p.altitude }));
    const future  = traj.slice(frame).map(p => ({ lat: p.latitude, lng: p.longitude, alt: p.altitude }));
    const current = traj[frame];

    setData("active-src", makeLineGeoJSON(active));
    setData("future-src", makeLineGeoJSON(future));
    setData("ascent-src", emptyGeoJSON());
    setData("descent-src", emptyGeoJSON());

    // Balloon marker
    if (!balloonRef.current) {
      balloonRef.current = new maplibregl.Marker({ element: makeMarkerEl("#22d3ee", 16, true), anchor: "center" })
        .setLngLat([current.longitude, current.latitude])
        .addTo(map);
    } else {
      balloonRef.current.setLngLat([current.longitude, current.latitude]);
    }

    // Altitude label overlay
    const el = balloonRef.current.getElement();
    const tag = el.querySelector<HTMLElement>("[data-alt-tag]");
    if (tag) {
      tag.textContent = `${(current.altitude / 1000).toFixed(1)} km`;
    } else {
      const altTag = document.createElement("div");
      altTag.setAttribute("data-alt-tag", "1");
      altTag.style.cssText = `
        margin-top:3px;font-size:10px;font-family:monospace;font-weight:bold;
        color:#22d3ee;background:rgba(0,0,0,0.7);padding:1px 5px;border-radius:4px;
        white-space:nowrap;border:1px solid #22d3ee40;pointer-events:none;
      `;
      altTag.textContent = `${(current.altitude / 1000).toFixed(1)} km`;
      el.appendChild(altTag);
    }

  }, [animFrame, simulationResult, setData]);

  // ── Plan cases ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    // Clear old landing markers for plan cases
    const planMarkers = markersRef.current.filter(m => (m.getElement() as any)._isPlanMarker);
    planMarkers.forEach(m => m.remove());

    for (let i = 0; i < 3; i++) {
      if (!planCases || !planCases[i]) {
        setData(`plan-ascent-${i}`,  emptyGeoJSON());
        setData(`plan-descent-${i}`, emptyGeoJSON());
        continue;
      }
      const fc = planCases[i];
      const traj = fc.simulation.trajectory;
      const opacity = selectedCaseIdx === null || selectedCaseIdx === i ? 1 : 0.25;

      setData(`plan-ascent-${i}`,  makeLineGeoJSON(traj.filter(p => p.phase === "ascent").map(p => ({ lat: p.latitude, lng: p.longitude, alt: p.altitude }))));
      setData(`plan-descent-${i}`, makeLineGeoJSON(traj.filter(p => p.phase === "descent").map(p => ({ lat: p.latitude, lng: p.longitude, alt: p.altitude }))));

      // Update layer opacity
      if (map.getLayer(`plan-ascent-layer-${i}`)) {
        map.setPaintProperty(`plan-ascent-layer-${i}`,  "line-opacity", opacity);
        map.setPaintProperty(`plan-descent-layer-${i}`, "line-opacity", opacity);
      }

      // Landing marker
      const landing = fc.simulation.landing;
      const color   = CASE_COLORS[i];
      const el      = makeMarkerEl(color, selectedCaseIdx === i ? 14 : 10, selectedCaseIdx === i, `Case ${i + 1}`);
      (el as any)._isPlanMarker = true;
      const m = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([landing.longitude, landing.latitude])
        .addTo(map);
      (m.getElement() as any)._isPlanMarker = true;
      markersRef.current.push(m);
    }

    // Fit bounds
    if (planCases && planCases.length > 0 && map) {
      const pts: [number, number][] = planCases.flatMap(fc =>
        fc.simulation.trajectory.map(p => [p.longitude, p.latitude] as [number, number])
      );
      if (pts.length >= 2) {
        const bounds = pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
        map.fitBounds(bounds, { padding: 80, duration: 800 });
      }
    }
  }, [planCases, selectedCaseIdx, setData]);

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="h-full w-full relative" style={{ background: "#0a0a0a" }}>
      {/* MapLibre container */}
      <div ref={containerRef} className="h-full w-full" />

      {/* Status badge */}
      <div className="absolute top-4 left-4 z-10 pointer-events-none">
        <div className="px-3 py-1.5 bg-black/80 backdrop-blur border border-border rounded-md shadow-lg text-xs font-mono tracking-wider text-muted-foreground flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          {clickMode === "launch" ? "출발지 클릭하세요" :
           clickMode === "target" ? "목적지 클릭하세요" :
           "SYSTEM ONLINE"}
        </div>
      </div>

      {/* 2D / 3D toggle */}
      <div className="absolute bottom-8 left-4 z-10">
        <button
          onClick={() => setIs3D(v => !v)}
          className={`px-3 py-1.5 rounded-md text-xs font-mono font-bold border transition-all shadow-lg backdrop-blur ${
            is3D
              ? "bg-cyan-500/20 border-cyan-500/60 text-cyan-300 hover:bg-cyan-500/30"
              : "bg-black/70 border-border text-muted-foreground hover:bg-white/10"
          }`}
        >
          {is3D ? "3D ▲" : "2D ▬"}
        </button>
      </div>
    </div>
  );
}
