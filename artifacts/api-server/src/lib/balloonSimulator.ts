// Pressure levels available from Open-Meteo upper-air API
const PRESSURE_LEVELS = [1000, 925, 850, 700, 500, 300, 200, 100, 50, 10] as const;
type PressureLevel = (typeof PRESSURE_LEVELS)[number];

// ISA constants
const P0 = 101325; // Pa — sea-level pressure
const G = 9.80665; // m/s² — gravity
const R = 287.05; // J/(kg·K) — dry air gas constant
const T0 = 288.15; // K — sea-level standard temperature
const L = 0.0065; // K/m — tropospheric lapse rate
const H_TROP = 11000; // m — tropopause altitude
const T_TROP = T0 - L * H_TROP; // K at tropopause

/** Convert altitude (m) → pressure (Pa) using ISA two-layer model */
function altitudeToPressure(h: number): number {
  if (h <= H_TROP) {
    // Troposphere: temperature decreases linearly
    return P0 * Math.pow(1 - (L * h) / T0, G / (R * L));
  } else {
    // Lower stratosphere: isothermal at T_TROP
    const pTrop = P0 * Math.pow(1 - (L * H_TROP) / T0, G / (R * L));
    return pTrop * Math.exp((-G * (h - H_TROP)) / (R * T_TROP));
  }
}

/** Find the nearest pressure level from PRESSURE_LEVELS */
function nearestPressureLevel(pressureHpa: number): PressureLevel {
  let best: PressureLevel = PRESSURE_LEVELS[0];
  let bestDiff = Math.abs(pressureHpa - PRESSURE_LEVELS[0]);
  for (const lvl of PRESSURE_LEVELS) {
    const diff = Math.abs(pressureHpa - lvl);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = lvl;
    }
  }
  return best;
}

/** Decompose meteorological wind into (vx, vy) in m/s
 *  Meteorological convention: 0° = wind FROM north, 90° = wind FROM east
 *  We convert so positive vx = eastward, positive vy = northward
 */
function windToVxVy(speedMs: number, dirDeg: number): [number, number] {
  const rad = (dirDeg * Math.PI) / 180;
  const vx = -speedMs * Math.sin(rad); // eastward component
  const vy = -speedMs * Math.cos(rad); // northward component
  return [vx, vy];
}

/** Update lat/lon given horizontal velocity and time step */
function updatePosition(
  lat: number,
  lon: number,
  vxMs: number,
  vyMs: number,
  dtSeconds: number
): [number, number] {
  const EARTH_RADIUS = 6371000; // m
  const dLat = (vyMs * dtSeconds * 180) / (Math.PI * EARTH_RADIUS);
  const dLon =
    (vxMs * dtSeconds * 180) / (Math.PI * EARTH_RADIUS * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lon + dLon];
}

/** Haversine distance in km between two lat/lon points */
function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Wind cache: level → { times, speed, direction } */
type WindCache = Record<
  number,
  { times: string[]; speed: number[]; direction: number[] }
>;

/**
 * Find the index in the times array closest to targetTime.
 * times are ISO 8601 strings (hourly).
 */
function findTimeIndex(times: string[], targetTime: Date): number {
  const target = targetTime.getTime();
  let bestIdx = 0;
  let bestDiff = Math.abs(new Date(times[0]).getTime() - target);
  for (let i = 1; i < times.length; i++) {
    const diff = Math.abs(new Date(times[i]).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Look up wind speed and direction for a given pressure level and time */
function lookupWind(
  cache: WindCache,
  pressureLevel: PressureLevel,
  currentTime: Date
): [number, number] {
  const data = cache[pressureLevel];
  if (!data) return [0, 0];
  const idx = findTimeIndex(data.times, currentTime);
  return [data.speed[idx] ?? 0, data.direction[idx] ?? 0];
}

// ─── Open-Meteo API fetcher ───────────────────────────────────────────────────

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

function buildOpenMeteoUrl(lat: number, lon: number): string {
  const speedParams = PRESSURE_LEVELS.map((p) => `windspeed_${p}hPa`).join(",");
  const dirParams = PRESSURE_LEVELS.map((p) => `winddirection_${p}hPa`).join(",");
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    hourly: `${speedParams},${dirParams}`,
    wind_speed_unit: "ms",
    forecast_days: "3",
    timezone: "UTC",
  });
  return `${OPEN_METEO_BASE}?${params}`;
}

export async function fetchWindCache(lat: number, lon: number): Promise<WindCache> {
  const url = buildOpenMeteoUrl(lat, lon);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`Open-Meteo API error: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { hourly: Record<string, unknown[]> };
  const hourly = json.hourly;
  const times = hourly["time"] as string[];

  const cache: WindCache = {};
  for (const level of PRESSURE_LEVELS) {
    const speedKey = `windspeed_${level}hPa`;
    const dirKey = `winddirection_${level}hPa`;
    cache[level] = {
      times,
      speed: (hourly[speedKey] ?? []) as number[],
      direction: (hourly[dirKey] ?? []) as number[],
    };
  }
  return cache;
}

// ─── Trajectory types ─────────────────────────────────────────────────────────

export interface TrajectoryPoint {
  time: string;
  latitude: number;
  longitude: number;
  altitude: number;
  phase: "ascent" | "descent";
  wind_speed: number;
  wind_direction: number;
  pressure_hpa: number;
}

export interface FlightStats {
  total_duration_seconds: number;
  ascent_duration_seconds: number;
  descent_duration_seconds: number;
  max_altitude: number;
  max_wind_speed: number;
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

// ─── Main simulator ───────────────────────────────────────────────────────────

export async function runBalloonSimulation(
  input: SimulationInput
): Promise<SimulationResult> {
  const {
    latitude,
    longitude,
    launch_datetime,
    ascent_rate,
    burst_altitude,
    descent_rate,
    time_step = 60,
  } = input;

  // 1. Fetch wind data once
  const windFetchedAt = new Date().toISOString();
  const windCache = await fetchWindCache(latitude, longitude);

  // 2. Run simulation loop
  const trajectory: TrajectoryPoint[] = [];
  let lat = latitude;
  let lon = longitude;
  let alt = 0;
  let phase: "ascent" | "descent" = "ascent";
  let elapsedSeconds = 0;
  let ascentDuration = 0;
  let totalPathKm = 0;
  let maxWindSpeed = 0;
  let prevLat = lat;
  let prevLon = lon;

  const launchTime = new Date(launch_datetime);

  // Guard against infinite loops
  const MAX_STEPS = 100000;

  for (let step = 0; step < MAX_STEPS; step++) {
    const currentTime = new Date(launchTime.getTime() + elapsedSeconds * 1000);

    // Current atmospheric pressure
    const pressurePa = altitudeToPressure(Math.max(alt, 0));
    const pressureHpa = pressurePa / 100;
    const level = nearestPressureLevel(pressureHpa);

    // Look up wind
    const [windSpeed, windDir] = lookupWind(windCache, level, currentTime);
    const [vx, vy] = windToVxVy(windSpeed, windDir);

    if (windSpeed > maxWindSpeed) maxWindSpeed = windSpeed;

    // Record point
    trajectory.push({
      time: currentTime.toISOString(),
      latitude: lat,
      longitude: lon,
      altitude: Math.round(alt),
      phase,
      wind_speed: Math.round(windSpeed * 10) / 10,
      wind_direction: Math.round(windDir),
      pressure_hpa: Math.round(pressureHpa * 10) / 10,
    });

    // Accumulate path distance
    if (step > 0) {
      totalPathKm += haversineKm(prevLat, prevLon, lat, lon);
    }
    prevLat = lat;
    prevLon = lon;

    // Update vertical position
    if (phase === "ascent") {
      alt += ascent_rate * time_step;
      if (alt >= burst_altitude) {
        alt = burst_altitude;
        ascentDuration = elapsedSeconds;
        phase = "descent";
      }
    } else {
      alt -= descent_rate * time_step;
      if (alt <= 0) {
        alt = 0;
        // Update position one last time then break
        [lat, lon] = updatePosition(lat, lon, vx, vy, time_step);
        // Final landing point
        trajectory.push({
          time: new Date(launchTime.getTime() + (elapsedSeconds + time_step) * 1000).toISOString(),
          latitude: lat,
          longitude: lon,
          altitude: 0,
          phase: "descent",
          wind_speed: Math.round(windSpeed * 10) / 10,
          wind_direction: Math.round(windDir),
          pressure_hpa: Math.round((P0 / 100) * 10) / 10,
        });
        elapsedSeconds += time_step;
        break;
      }
    }

    // Update horizontal position
    [lat, lon] = updatePosition(lat, lon, vx, vy, time_step);
    elapsedSeconds += time_step;
  }

  const landing = trajectory[trajectory.length - 1];
  const descentDuration = elapsedSeconds - ascentDuration;
  const driftKm = haversineKm(latitude, longitude, landing.latitude, landing.longitude);

  const stats: FlightStats = {
    total_duration_seconds: elapsedSeconds,
    ascent_duration_seconds: ascentDuration,
    descent_duration_seconds: descentDuration,
    max_altitude: burst_altitude,
    max_wind_speed: Math.round(maxWindSpeed * 10) / 10,
    total_distance_km: Math.round(totalPathKm * 10) / 10,
    horizontal_drift_km: Math.round(driftKm * 10) / 10,
  };

  return {
    trajectory,
    landing,
    stats,
    wind_data_fetched_at: windFetchedAt,
  };
}
