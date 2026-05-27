import { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { SimulationResult, TrajectoryPoint } from "@workspace/api-client-react";
import type { FlightCase } from "@workspace/api-client-react";

// Inline style using CARTO raster tiles — no external style.json fetch needed
const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    "carto-dark": {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution: "© <a href='https://carto.com/attributions'>CARTO</a>",
    },
  },
  layers: [
    {
      id: "carto-dark-layer",
      type: "raster",
      source: "carto-dark",
      minzoom: 0,
      maxzoom: 22,
    },
  ],
};

const CASE_COLORS = ["#22c55e", "#3b82f6", "#f59e0b"] as const;

// Altitude exaggeration factor so paths visually float above the raster map
// At regional zoom level, raw meters are too small to see; exaggerate 6×
const ALT_SCALE = 6;

type Pt3D = { lat: number; lng: number; alt: number };

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

// ── GeoJSON helpers ────────────────────────────────────────────────────────────

function makeLineGeoJSON(pts: Pt3D[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features:
      pts.length < 2
        ? []
        : [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: pts.map((p) => [p.lng, p.lat, p.alt * ALT_SCALE]),
              },
            },
          ],
  };
}

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function trajToPt3D(p: TrajectoryPoint): Pt3D {
  return { lat: p.latitude, lng: p.longitude, alt: p.altitude };
}

// ── Marker element helpers ─────────────────────────────────────────────────────

function makeDotEl(color: string, size = 14, glow = false, label?: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:relative;display:flex;flex-direction:column;align-items:center;pointer-events:none;";

  const dot = document.createElement("div");
  dot.style.cssText = `
    width:${size}px;height:${size}px;border-radius:50%;
    background:${color};border:2px solid #fff;
    box-shadow:${glow ? `0 0 12px 4px ${color}80` : "0 0 4px rgba(0,0,0,0.5)"};
  `;
  wrap.appendChild(dot);

  if (label) {
    const tag = document.createElement("div");
    tag.style.cssText = `
      margin-top:3px;font-size:10px;font-family:monospace;font-weight:bold;
      color:${color};background:rgba(0,0,0,0.75);padding:1px 5px;
      border-radius:4px;white-space:nowrap;border:1px solid ${color}50;
    `;
    tag.textContent = label;
    wrap.appendChild(tag);
  }

  return wrap;
}

function makeTargetEl(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "width:32px;height:32px;position:relative;pointer-events:none;";
  el.innerHTML = `
    <div style="position:absolute;inset:0;border-radius:50%;border:3px solid #a855f7;box-shadow:0 0 12px 3px #a855f780;"></div>
    <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:8px;height:8px;border-radius:50%;background:#a855f7;"></div>
    <div style="position:absolute;top:50%;left:0;width:100%;height:1px;background:#a855f740;"></div>
    <div style="position:absolute;top:0;left:50%;width:1px;height:100%;background:#a855f740;"></div>
  `;
  return el;
}

// ── Main component ─────────────────────────────────────────────────────────────

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
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loadedRef = useRef(false);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const balloonRef = useRef<maplibregl.Marker | null>(null);
  const launchMarkerRef = useRef<maplibregl.Marker | null>(null);
  const targetMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [is3D, setIs3D] = useState(true);

  // ── Set GeoJSON source data ───────────────────────────────────────────────

  const setData = useCallback((id: string, data: GeoJSON.FeatureCollection) => {
    const src = mapRef.current?.getSource(id) as maplibregl.GeoJSONSource | undefined;
    src?.setData(data);
  }, []);

  const clearSimMarkers = useCallback(() => {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
  }, []);

  // ── Initialize map (once) ─────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [launchPos.lng, launchPos.lat],
      zoom: 7,
      pitch: 55,
      bearing: 15,
      canvasContextAttributes: { antialias: false, powerPreference: "default" as WebGLPowerPreference },
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");

    map.on("load", () => {
      loadedRef.current = true;

      const sourceIds = [
        "ascent-src", "descent-src", "active-src", "future-src",
        ...Array.from({ length: 3 }, (_, i) => `plan-ascent-${i}`),
        ...Array.from({ length: 3 }, (_, i) => `plan-descent-${i}`),
      ];

      for (const id of sourceIds) {
        map.addSource(id, { type: "geojson", data: emptyFC() });
      }

      // Plan case lines (under simulation lines)
      for (let i = 0; i < 3; i++) {
        const color = CASE_COLORS[i];
        map.addLayer({
          id: `plan-ascent-layer-${i}`,
          type: "line",
          source: `plan-ascent-${i}`,
          paint: { "line-color": color, "line-width": 2.5, "line-opacity": 1, "line-dasharray": [4, 6] },
        });
        map.addLayer({
          id: `plan-descent-layer-${i}`,
          type: "line",
          source: `plan-descent-${i}`,
          paint: { "line-color": color, "line-width": 2.5, "line-opacity": 1 },
        });
      }

      // Simulation full path
      map.addLayer({
        id: "ascent-layer",
        type: "line",
        source: "ascent-src",
        paint: { "line-color": "#0ea5e9", "line-width": 3, "line-opacity": 0.9, "line-dasharray": [5, 8] },
      });
      map.addLayer({
        id: "descent-layer",
        type: "line",
        source: "descent-src",
        paint: { "line-color": "#f97316", "line-width": 3, "line-opacity": 0.9, "line-dasharray": [5, 8] },
      });

      // Animation trail
      map.addLayer({
        id: "active-layer",
        type: "line",
        source: "active-src",
        paint: { "line-color": "#0ea5e9", "line-width": 4, "line-opacity": 1 },
      });
      map.addLayer({
        id: "future-layer",
        type: "line",
        source: "future-src",
        paint: { "line-color": "#ffffff", "line-width": 2, "line-opacity": 0.2, "line-dasharray": [4, 8] },
      });
    });

    return () => {
      loadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Toggle 3D / 2D ────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ pitch: is3D ? 55 : 0, bearing: is3D ? 15 : 0, duration: 700 });
  }, [is3D]);

  // ── Click handling ────────────────────────────────────────────────────────

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

  // ── Launch marker ─────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    launchMarkerRef.current?.remove();
    launchMarkerRef.current = new maplibregl.Marker({
      element: makeDotEl("#10b981", 14, false, "출발지"),
      anchor: "bottom",
    })
      .setLngLat([launchPos.lng, launchPos.lat])
      .addTo(map);
    return () => { launchMarkerRef.current?.remove(); };
  }, [launchPos.lat, launchPos.lng]);

  // ── Target marker ─────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    targetMarkerRef.current?.remove();
    targetMarkerRef.current = null;
    if (targetPos) {
      targetMarkerRef.current = new maplibregl.Marker({
        element: makeTargetEl(),
        anchor: "center",
      })
        .setLngLat([targetPos.lng, targetPos.lat])
        .addTo(map);
    }
    return () => { targetMarkerRef.current?.remove(); };
  }, [targetPos?.lat, targetPos?.lng]);

  // ── Simulation result ─────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    clearSimMarkers();
    balloonRef.current?.remove();
    balloonRef.current = null;

    setData("active-src",  emptyFC());
    setData("future-src",  emptyFC());

    if (!simulationResult) {
      setData("ascent-src",  emptyFC());
      setData("descent-src", emptyFC());
      return;
    }

    const traj = simulationResult.trajectory;
    const isAnim = animFrame !== undefined && animFrame >= 0 && animFrame < traj.length;

    if (isAnim) {
      setData("ascent-src",  emptyFC());
      setData("descent-src", emptyFC());
    } else {
      setData("ascent-src",  makeLineGeoJSON(traj.filter((p) => p.phase === "ascent").map(trajToPt3D)));
      setData("descent-src", makeLineGeoJSON(traj.filter((p) => p.phase === "descent").map(trajToPt3D)));

      // Burst marker
      const burst = traj.find((p) => p.phase === "descent");
      if (burst) {
        const m = new maplibregl.Marker({
          element: makeDotEl("#eab308", 13, false, `Burst ${(burst.altitude / 1000).toFixed(1)}km`),
          anchor: "bottom",
        })
          .setLngLat([burst.longitude, burst.latitude])
          .addTo(map);
        markersRef.current.push(m);
      }

      // Landing marker
      const landing = simulationResult.landing;
      const lm = new maplibregl.Marker({
        element: makeDotEl("#ef4444", 14, false, "Landing"),
        anchor: "bottom",
      })
        .setLngLat([landing.longitude, landing.latitude])
        .addTo(map);
      markersRef.current.push(lm);

      // Fit bounds
      if (traj.length >= 2) {
        const first: [number, number] = [traj[0].longitude, traj[0].latitude];
        const bounds = traj.reduce(
          (b, p) => b.extend([p.longitude, p.latitude] as [number, number]),
          new maplibregl.LngLatBounds(first, first)
        );
        map.fitBounds(bounds, { padding: 80, duration: 800 });
      }
    }
  }, [simulationResult, clearSimMarkers, setData]);

  // ── Animation frame ───────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !simulationResult) return;

    const traj = simulationResult.trajectory;
    const isAnim = animFrame !== undefined && animFrame >= 0 && animFrame < traj.length;
    if (!isAnim) return;

    const frame   = Math.min(animFrame!, traj.length - 1);
    const active  = traj.slice(0, frame + 1).map(trajToPt3D);
    const future  = traj.slice(frame).map(trajToPt3D);
    const current = traj[frame];

    setData("active-src",  makeLineGeoJSON(active));
    setData("future-src",  makeLineGeoJSON(future));
    setData("ascent-src",  emptyFC());
    setData("descent-src", emptyFC());

    if (!balloonRef.current) {
      balloonRef.current = new maplibregl.Marker({
        element: makeDotEl("#22d3ee", 16, true),
        anchor: "center",
      })
        .setLngLat([current.longitude, current.latitude])
        .addTo(map);
    } else {
      balloonRef.current.setLngLat([current.longitude, current.latitude]);
    }

    // Update / add altitude tag on balloon marker element
    const el = balloonRef.current.getElement();
    let tag = el.querySelector<HTMLElement>("[data-alt-tag]");
    if (!tag) {
      tag = document.createElement("div");
      tag.setAttribute("data-alt-tag", "1");
      tag.style.cssText = `
        margin-top:3px;font-size:10px;font-family:monospace;font-weight:bold;
        color:#22d3ee;background:rgba(0,0,0,0.75);padding:1px 5px;
        border-radius:4px;white-space:nowrap;border:1px solid #22d3ee50;pointer-events:none;
      `;
      el.appendChild(tag);
    }
    tag.textContent = `${(current.altitude / 1000).toFixed(1)} km`;
  }, [animFrame, simulationResult, setData]);

  // ── Plan cases ────────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    // Remove old plan landing markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    for (let i = 0; i < 3; i++) {
      if (!planCases || !planCases[i]) {
        setData(`plan-ascent-${i}`,  emptyFC());
        setData(`plan-descent-${i}`, emptyFC());
        continue;
      }

      const fc   = planCases[i];
      const traj = fc.simulation.trajectory;
      const opacity = selectedCaseIdx === null || selectedCaseIdx === undefined || selectedCaseIdx === i ? 1 : 0.25;

      setData(
        `plan-ascent-${i}`,
        makeLineGeoJSON(traj.filter((p) => p.phase === "ascent").map(trajToPt3D))
      );
      setData(
        `plan-descent-${i}`,
        makeLineGeoJSON(traj.filter((p) => p.phase === "descent").map(trajToPt3D))
      );

      if (map.getLayer(`plan-ascent-layer-${i}`)) {
        map.setPaintProperty(`plan-ascent-layer-${i}`,  "line-opacity", opacity);
        map.setPaintProperty(`plan-descent-layer-${i}`, "line-opacity", opacity);
      }

      const landing = fc.simulation.landing;
      const color   = CASE_COLORS[i];
      const isSelected = selectedCaseIdx === i;
      const m = new maplibregl.Marker({
        element: makeDotEl(color, isSelected ? 14 : 10, isSelected, `Case ${i + 1}`),
        anchor: "bottom",
      })
        .setLngLat([landing.longitude, landing.latitude])
        .addTo(map);
      markersRef.current.push(m);
    }

    // Fit bounds
    if (planCases && planCases.length > 0) {
      const all = planCases.flatMap((fc) => fc.simulation.trajectory);
      if (all.length >= 2) {
        const first: [number, number] = [all[0].longitude, all[0].latitude];
        const bounds = all.reduce(
          (b, p) => b.extend([p.longitude, p.latitude] as [number, number]),
          new maplibregl.LngLatBounds(first, first)
        );
        map.fitBounds(bounds, { padding: 80, duration: 800 });
      }
    }
  }, [planCases, selectedCaseIdx, setData]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-full w-full relative" style={{ background: "#0a0a0a" }}>
      <div ref={containerRef} className="h-full w-full" />

      {/* Status badge */}
      <div className="absolute top-4 left-4 z-10 pointer-events-none">
        <div className="px-3 py-1.5 bg-black/80 backdrop-blur border border-border rounded-md shadow-lg text-xs font-mono tracking-wider text-muted-foreground flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          {clickMode === "launch"
            ? "출발지 클릭하세요"
            : clickMode === "target"
            ? "목적지 클릭하세요"
            : "SYSTEM ONLINE"}
        </div>
      </div>

      {/* 2D / 3D toggle */}
      <div className="absolute bottom-8 left-4 z-10">
        <button
          onClick={() => setIs3D((v) => !v)}
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
