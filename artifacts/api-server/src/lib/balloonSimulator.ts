/**
 * Balloon Trajectory Simulator
 * Physics: ISA 5-layer atmosphere, bilinear wind interpolation
 * (temporal: linear between hourly samples; vertical: log-pressure between levels)
 */

// Pressure levels from Open-Meteo upper-air API — sorted descending (high→low altitude)
const PRESSURE_LEVELS_DESC = [1000, 925, 850, 700, 500, 300, 200, 100, 50, 10] as const;
type PressureLevel = (typeof PRESSURE_LEVELS_DESC)[number];

// ─── ISA 5-Layer Atmosphere ──────────────────────────────────────────────────
// Sources: ICAO Doc 7488/3, ISO 2533:1975
const G = 9.80665;   // m/s²
const R = 287.05287; // J/(kg·K)
const P0 = 101325;   // Pa
const T0 = 288.15;   // K

interface AtmLayer {
  hBase: number;   // m
  tBase: number;   // K
  pBase: number;   // Pa (computed)
  lapse: number;   // K/m (0 = isothermal)
}

const ATM_LAYERS: AtmLayer[] = [
  { hBase: 0,      tBase: 288.15, pBase: 101325,  lapse: -0.0065 },
  { hBase: 11000,  tBase: 216.65, pBase: 22632.1,  lapse: 0       },
  { hBase: 20000,  tBase: 216.65, pBase: 5474.89,  lapse: 0.001   },
  { hBase: 32000,  tBase: 228.65, pBase: 868.019,  lapse: 0.0028  },
  { hBase: 47000,  tBase: 270.65, pBase: 110.906,  lapse: 0       },
];

/** ISA temperature at altitude h (m) */
function isaTemperature(h: number): number {
  const layer = [...ATM_LAYERS].reverse().find(l => h >= l.hBase) ?? ATM_LAYERS[0];
  return layer.tBase + layer.lapse * (h - layer.hBase);
}

/** ISA pressure at altitude h (m) — 5-layer model */
function altitudeToPressure(h: number): number {
  if (h < 0) return P0;
  const layer = [...ATM_LAYERS].reverse().find(l => h >= l.hBase) ?? ATM_LAYERS[0];
  const dh = h - layer.hBase;
  if (layer.lapse === 0) {
    return layer.pBase * Math.exp((-G * dh) / (R * layer.tBase));
  }
  return layer.pBase * Math.pow(layer.tBase / (layer.tBase + layer.lapse * dh), G / (R * layer.lapse));
}

// ─── Wind interpolation ───────────────────────────────────────────────────────

type WindCache = Record<number, { times: number[]; vx: number[]; vy: number[] }>;

/** Wind vector components at a specific pressure level + time (temporal linear interpolation) */
function getWindVector(
  cache: WindCache,
  level: PressureLevel,
  tMs: number
): [number, number] {
  const d = cache[level];
  if (!d || d.times.length === 0) return [0, 0];

  if (tMs <= d.times[0]) return [d.vx[0], d.vy[0]];
  if (tMs >= d.times[d.times.length - 1]) {
    const last = d.times.length - 1;
    return [d.vx[last], d.vy[last]];
  }

  // Binary search for bracketing interval
  let lo = 0, hi = d.times.length - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d.times[mid + 1] <= tMs) lo = mid + 1;
    else hi = mid;
  }

  const t = (tMs - d.times[lo]) / (d.times[lo + 1] - d.times[lo]);
  return [
    d.vx[lo] + t * (d.vx[lo + 1] - d.vx[lo]),
    d.vy[lo] + t * (d.vy[lo + 1] - d.vy[lo]),
  ];
}

/**
 * Bilinear wind at arbitrary pressure (hPa) + time (ms).
 * Interpolates vertically in log-pressure space between the two bracketing levels.
 */
function getInterpolatedWind(
  cache: WindCache,
  pressureHpa: number,
  tMs: number
): [number, number] {
  const levels = PRESSURE_LEVELS_DESC;

  // Clamp to available range
  if (pressureHpa >= levels[0]) return getWindVector(cache, levels[0], tMs);
  if (pressureHpa <= levels[levels.length - 1]) {
    return getWindVector(cache, levels[levels.length - 1], tMs);
  }

  // Find bracketing levels: lvlHi has higher hPa (lower altitude), lvlLo has lower hPa (higher altitude)
  let idxLo = 0;
  for (let i = 0; i < levels.length - 1; i++) {
    if (pressureHpa <= levels[i] && pressureHpa >= levels[i + 1]) {
      idxLo = i + 1; // lower pressure = higher altitude
      break;
    }
  }
  const lvlHiAlt = levels[idxLo] as PressureLevel;     // lower hPa = higher altitude
  const lvlLoAlt = levels[idxLo - 1] as PressureLevel; // higher hPa = lower altitude

  // Log-pressure interpolation weight
  const logP  = Math.log(pressureHpa);
  const logLo = Math.log(lvlLoAlt);
  const logHi = Math.log(lvlHiAlt);
  const t = (logP - logLo) / (logHi - logLo); // 0 → at lower-alt level, 1 → at higher-alt level

  const [vxLo, vyLo] = getWindVector(cache, lvlLoAlt, tMs);
  const [vxHi, vyHi] = getWindVector(cache, lvlHiAlt, tMs);

  return [
    vxLo + t * (vxHi - vxLo),
    vyLo + t * (vyHi - vyLo),
  ];
}

// ─── Geodesy helpers ──────────────────────────────────────────────────────────

const EARTH_R = 6371000; // m

function updatePosition(
  lat: number, lon: number,
  vxMs: number, vyMs: number,
  dt: number
): [number, number] {
  const dLat = (vyMs * dt * 180) / (Math.PI * EARTH_R);
  const dLon = (vxMs * dt * 180) / (Math.PI * EARTH_R * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lon + dLon];
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Bearing from (lat1,lon1) toward (lat2,lon2) in degrees [0-360] */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// ─── Open-Meteo fetcher ───────────────────────────────────────────────────────

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

export async function fetchWindCache(lat: number, lon: number): Promise<WindCache> {
  const speedParams = PRESSURE_LEVELS_DESC.map(p => `windspeed_${p}hPa`).join(",");
  const dirParams   = PRESSURE_LEVELS_DESC.map(p => `winddirection_${p}hPa`).join(",");
  const url = `${OPEN_METEO_BASE}?${new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    hourly: `${speedParams},${dirParams}`,
    wind_speed_unit: "ms",
    forecast_days: "3",
    timezone: "UTC",
  })}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Open-Meteo API error: ${res.status} ${res.statusText}`);

  const json = (await res.json()) as { hourly: Record<string, unknown[]> };
  const h = json.hourly;
  const times = (h["time"] as string[]).map(t => new Date(t).getTime());

  const cache: WindCache = {};
  for (const level of PRESSURE_LEVELS_DESC) {
    const speeds = (h[`windspeed_${level}hPa`] ?? []) as number[];
    const dirs   = (h[`winddirection_${level}hPa`] ?? []) as number[];
    const vx: number[] = [];
    const vy: number[] = [];
    for (let i = 0; i < speeds.length; i++) {
      const rad = (dirs[i] * Math.PI) / 180;
      // Met convention: direction = FROM; decompose to eastward/northward
      vx.push(-speeds[i] * Math.sin(rad));
      vy.push(-speeds[i] * Math.cos(rad));
    }
    cache[level] = { times, vx, vy };
  }
  return cache;
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface TrajectoryPoint {
  time: string;
  latitude: number;
  longitude: number;
  altitude: number;
  phase: "ascent" | "descent";
  wind_speed: number;
  wind_direction: number;
  pressure_hpa: number;
  horizontal_speed: number;
  vertical_speed: number;
  total_speed: number;
  bearing: number;
}

export interface FlightStats {
  total_duration_seconds: number;
  ascent_duration_seconds: number;
  descent_duration_seconds: number;
  max_altitude: number;
  max_wind_speed: number;
  max_horizontal_speed: number;
  max_total_speed: number;
  total_distance_km: number;
  horizontal_drift_km: number;
}

export interface SimulationResult {
  trajectory: TrajectoryPoint[];
  landing: TrajectoryPoint;
  stats: FlightStats;
  wind_data_fetched_at: string;
}

export interface SimulationInput {
  latitude: number;
  longitude: number;
  launch_datetime: string;
  ascent_rate: number;
  burst_altitude: number;
  descent_rate: number;
  time_step?: number;
}

// ─── Main simulation ──────────────────────────────────────────────────────────

export async function runBalloonSimulation(input: SimulationInput): Promise<SimulationResult> {
  const { latitude, longitude, launch_datetime, ascent_rate, burst_altitude, descent_rate, time_step = 60 } = input;

  const windFetchedAt = new Date().toISOString();
  const windCache     = await fetchWindCache(latitude, longitude);

  const trajectory: TrajectoryPoint[] = [];
  let lat = latitude, lon = longitude, alt = 0;
  let phase: "ascent" | "descent" = "ascent";
  let elapsedSec = 0, ascentDuration = 0;
  let totalPathKm = 0;
  let maxWindSpeed = 0, maxHorizSpeed = 0, maxTotalSpeed = 0;
  let prevLat = lat, prevLon = lon;

  const launchMs = new Date(launch_datetime).getTime();
  const MAX_STEPS = 100000;

  for (let step = 0; step < MAX_STEPS; step++) {
    const tMs          = launchMs + elapsedSec * 1000;
    const pressurePa   = altitudeToPressure(Math.max(alt, 0));
    const pressureHpa  = pressurePa / 100;
    const [vx, vy]     = getInterpolatedWind(windCache, pressureHpa, tMs);

    const windSpeedMs  = Math.sqrt(vx * vx + vy * vy);
    const windDirDeg   = ((Math.atan2(-vx, -vy) * 180) / Math.PI + 360) % 360;
    const vertSpeedMs  = phase === "ascent" ? ascent_rate : -descent_rate;
    const horizSpeedMs = windSpeedMs; // balloon drifts at wind speed horizontally
    const totalSpeedMs = Math.sqrt(horizSpeedMs ** 2 + vertSpeedMs ** 2);

    // Bearing: direction balloon is moving horizontally
    const moveBearing  = phase === "ascent" || step === 0
      ? (((Math.atan2(vx, vy) * 180) / Math.PI) + 360) % 360
      : bearingDeg(prevLat, prevLon, lat, lon);

    if (windSpeedMs   > maxWindSpeed)  maxWindSpeed  = windSpeedMs;
    if (horizSpeedMs  > maxHorizSpeed) maxHorizSpeed = horizSpeedMs;
    if (totalSpeedMs  > maxTotalSpeed) maxTotalSpeed = totalSpeedMs;

    trajectory.push({
      time:             new Date(tMs).toISOString(),
      latitude:         Math.round(lat * 100000) / 100000,
      longitude:        Math.round(lon * 100000) / 100000,
      altitude:         Math.round(alt),
      phase,
      wind_speed:       Math.round(windSpeedMs * 10) / 10,
      wind_direction:   Math.round(windDirDeg),
      pressure_hpa:     Math.round(pressureHpa * 10) / 10,
      horizontal_speed: Math.round(horizSpeedMs * 10) / 10,
      vertical_speed:   Math.round(vertSpeedMs * 10) / 10,
      total_speed:      Math.round(totalSpeedMs * 10) / 10,
      bearing:          Math.round(moveBearing),
    });

    if (step > 0) totalPathKm += haversineKm(prevLat, prevLon, lat, lon);
    prevLat = lat;
    prevLon = lon;

    // Update position
    [lat, lon] = updatePosition(lat, lon, vx, vy, time_step);

    // Update altitude
    if (phase === "ascent") {
      alt += ascent_rate * time_step;
      if (alt >= burst_altitude) {
        alt = burst_altitude;
        ascentDuration = elapsedSec;
        phase = "descent";
      }
    } else {
      alt -= descent_rate * time_step;
      if (alt <= 0) {
        // Final landing point
        const landTMs = tMs + time_step * 1000;
        const [lx, ly] = getInterpolatedWind(windCache, P0 / 100, landTMs);
        const landWindSpeed = Math.sqrt(lx * lx + ly * ly);
        trajectory.push({
          time:             new Date(landTMs).toISOString(),
          latitude:         Math.round(lat * 100000) / 100000,
          longitude:        Math.round(lon * 100000) / 100000,
          altitude:         0,
          phase:            "descent",
          wind_speed:       Math.round(landWindSpeed * 10) / 10,
          wind_direction:   Math.round((((Math.atan2(-lx, -ly) * 180) / Math.PI) + 360) % 360),
          pressure_hpa:     Math.round(P0 / 100),
          horizontal_speed: Math.round(landWindSpeed * 10) / 10,
          vertical_speed:   -descent_rate,
          total_speed:      Math.round(Math.sqrt(landWindSpeed ** 2 + descent_rate ** 2) * 10) / 10,
          bearing:          bearingDeg(prevLat, prevLon, lat, lon),
        });
        elapsedSec += time_step;
        break;
      }
    }
    elapsedSec += time_step;
  }

  const landing = trajectory[trajectory.length - 1];
  const stats: FlightStats = {
    total_duration_seconds:  elapsedSec,
    ascent_duration_seconds: ascentDuration,
    descent_duration_seconds: elapsedSec - ascentDuration,
    max_altitude:           burst_altitude,
    max_wind_speed:         Math.round(maxWindSpeed * 10) / 10,
    max_horizontal_speed:   Math.round(maxHorizSpeed * 10) / 10,
    max_total_speed:        Math.round(maxTotalSpeed * 10) / 10,
    total_distance_km:      Math.round(totalPathKm * 10) / 10,
    horizontal_drift_km:    Math.round(haversineKm(latitude, longitude, landing.latitude, landing.longitude) * 10) / 10,
  };

  return { trajectory, landing, stats, wind_data_fetched_at: windFetchedAt };
}
