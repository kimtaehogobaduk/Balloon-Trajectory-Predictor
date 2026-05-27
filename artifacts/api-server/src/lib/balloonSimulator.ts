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

export type WindCache = Record<number, { times: number[]; vx: number[]; vy: number[] }>;

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

// ─── Balloon burst physics ────────────────────────────────────────────────────

const RHO_HE_SL = 101325 / (2077 * 288.15); // ≈ 0.1693 kg/m³  (R_He = 2077 J/kg·K)
const C_D_BALLOON = 0.47; // drag coefficient of a sphere
const C_D_PARA    = 1.5;  // parachute drag coefficient

/**
 * Empirical burst diameter for a latex balloon of given mass.
 * Fit to Kaymont/Totex manufacturer data.
 *   100g  → ~4.5 m   200g → ~5.5 m   600g → ~7.5 m
 *   1000g → ~9.0 m   1500g → ~10.2 m   2000g → ~11.3 m
 */
function burstDiameter(balloonMassKg: number): number {
  return 4.5 * Math.pow(balloonMassKg / 0.1, 0.30);
}

export interface BalloonConfig {
  fill_diameter_m:   number;
  burst_diameter_m:  number;
  burst_altitude_m:  number;
  neck_lift_n:       number;
  volume_fill_m3:    number;
  ascent_rate_ms:    number;
  descent_rate_sl_ms: number;
}

/**
 * Derives all balloon configuration values from physical inputs.
 */
export function calculateBalloonConfig(
  balloonMassG:      number,
  payloadMassG:      number,
  heliumVolumeM3:    number,
  parachuteDiameterM: number,
  parachuteCd:       number,
): BalloonConfig {
  const m_total = (balloonMassG + payloadMassG) / 1000; // kg

  // ── Fill geometry (direct from helium volume) ─────────────────────────────
  const r_fill  = Math.cbrt(3 * heliumVolumeM3 / (4 * Math.PI));
  const d_fill  = r_fill * 2;

  // ── Burst geometry (from balloon mass) ───────────────────────────────────
  const d_burst = burstDiameter(balloonMassG / 1000);
  const r_burst = d_burst / 2;
  const V_burst = (4 / 3) * Math.PI * r_burst ** 3;

  // ── Neck lift (net upward force at sea level) ─────────────────────────────
  const rho0      = P0 / (R * T0); // ≈ 1.225 kg/m³
  const rho_He0   = P0 / (RHO_HE_SL > 0 ? (2077 * T0) : 1);
  const lift_coeff_sl = rho0 - (P0 / (2077 * T0));
  const gross_lift_N  = lift_coeff_sl * heliumVolumeM3 * G;
  const neck_lift_N   = gross_lift_N - m_total * G;

  // ── Sea-level ascent rate ─────────────────────────────────────────────────
  const ascent_rate_ms = ascentRatePhysics(0, heliumVolumeM3, m_total);

  // ── Sea-level descent rate ────────────────────────────────────────────────
  const descent_rate_sl_ms = descentRatePhysics(0, parachuteDiameterM, parachuteCd, m_total);

  // ── Burst altitude: binary search where expansion = V_burst / V_fill ──────
  const expTarget = V_burst / heliumVolumeM3;
  let hLo = 0, hHi = 65000;
  for (let i = 0; i < 64; i++) {
    const hMid = (hLo + hHi) / 2;
    const P    = altitudeToPressure(hMid);
    const T    = isaTemperature(hMid);
    const expH = (P0 / P) * (T / T0);
    if (expH < expTarget) hLo = hMid;
    else                  hHi = hMid;
  }
  const burst_alt = (hLo + hHi) / 2;

  return {
    fill_diameter_m:    Math.round(d_fill * 1000) / 1000,
    burst_diameter_m:   Math.round(d_burst * 1000) / 1000,
    burst_altitude_m:   Math.round(burst_alt),
    neck_lift_n:        Math.round(neck_lift_N * 100) / 100,
    volume_fill_m3:     Math.round(heliumVolumeM3 * 1000) / 1000,
    ascent_rate_ms:     Math.round(ascent_rate_ms * 100) / 100,
    descent_rate_sl_ms: Math.round(descent_rate_sl_ms * 100) / 100,
  };
}

// ─── Atmosphere density & realistic vertical velocity ────────────────────────

/** ISA air density at altitude h (kg/m³) */
function airDensity(h: number): number {
  const p = altitudeToPressure(Math.max(h, 0));
  const T = isaTemperature(Math.max(h, 0));
  return p / (R * T);
}

/** Sea-level air density (kg/m³) */
const RHO_0 = P0 / (R * T0); // ≈ 1.225 kg/m³

const R_HE = 2077; // J/(kg·K) – helium specific gas constant

function ascentRatePhysics(h: number, V_fill_sl: number, m_total: number): number {
  const P       = altitudeToPressure(Math.max(h, 0));
  const T       = isaTemperature(Math.max(h, 0));
  const rho_air = P / (R * T);
  const rho_He  = P / (R_HE * T);

  const expansion = (P0 / P) * (T / T0);
  const V   = V_fill_sl * expansion;
  const r   = Math.cbrt(3 * V / (4 * Math.PI));

  const net_force = (rho_air - rho_He) * V * G - m_total * G;
  if (net_force <= 0) return 0.3;

  const drag_denom = 0.5 * C_D_BALLOON * rho_air * Math.PI * r * r;
  return Math.min(50, Math.sqrt(net_force / drag_denom));
}

function descentRatePhysics(h: number, parachuteDiamM: number, parachuteCd: number, m_total: number): number {
  const P       = altitudeToPressure(Math.max(h, 0));
  const T       = isaTemperature(Math.max(h, 0));
  const rho_air = P / (R * T);
  const A_chute = Math.PI * (parachuteDiamM / 2) ** 2;
  return Math.min(150, Math.sqrt(2 * m_total * G / (parachuteCd * rho_air * A_chute)));
}

function turbulenceSigma(h: number): number {
  if (h < 3000)  return 0.42;
  if (h < 12000) return 0.80;
  if (h < 20000) return 0.20;
  return 0.08;
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
    forecast_days: "7",
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
  balloon_config: BalloonConfig;
  wind_data_fetched_at: string;
}

export interface SimulationInput {
  latitude:            number;
  longitude:           number;
  launch_datetime:     string;
  balloon_mass_g:      number;
  payload_mass_g:      number;
  helium_volume_m3:    number;
  parachute_diameter_m: number;
  parachute_cd:        number;
  time_step?:          number;
}

// ─── Core simulation (reusable with pre-fetched wind cache) ───────────────────

export function runSimulationCore(
  input: SimulationInput,
  windCache: WindCache,
  windFetchedAt: string,
  deterministicSeed?: number
): SimulationResult {
  const {
    latitude, longitude, launch_datetime,
    balloon_mass_g, payload_mass_g,
    helium_volume_m3, parachute_diameter_m, parachute_cd,
    time_step = 60,
  } = input;

  const m_total = (balloon_mass_g + payload_mass_g) / 1000;

  const balloonConfig  = calculateBalloonConfig(
    balloon_mass_g, payload_mass_g, helium_volume_m3, parachute_diameter_m, parachute_cd
  );
  const burst_altitude = balloonConfig.burst_altitude_m;

  if (balloonConfig.ascent_rate_ms < 0.3) {
    throw new Error(
      `헬륨 부력 부족: 현재 ${helium_volume_m3}m³ 헬륨으로는 ` +
      `${balloon_mass_g}g 풍선 + ${payload_mass_g}g 탑재물을 ` +
      `들어올리기 어렵습니다. 헬륨량을 늘려주세요.`
    );
  }

  const trajectory: TrajectoryPoint[] = [];
  let lat = latitude, lon = longitude, alt = 0;
  let phase: "ascent" | "descent" = "ascent";
  let elapsedSec = 0, ascentDuration = 0;
  let totalPathKm = 0;
  let maxWindSpeed = 0, maxHorizSpeed = 0, maxTotalSpeed = 0;
  let prevLat = lat, prevLon = lon;

  const launchMs = new Date(launch_datetime).getTime();
  const MAX_STEPS = 100000;

  // Use a simple deterministic pseudo-random for planning (reproducible results)
  let rngState = deterministicSeed ?? Math.random() * 100000;
  const rng = () => {
    rngState = (rngState * 1664525 + 1013904223) % 4294967296;
    return rngState / 4294967296;
  };

  let turbVz = 0;
  const turbTheta = 1 - Math.exp(-1 / 5);

  for (let step = 0; step < MAX_STEPS; step++) {
    const tMs         = launchMs + elapsedSec * 1000;
    const pressurePa  = altitudeToPressure(Math.max(alt, 0));
    const pressureHpa = pressurePa / 100;
    const [vx, vy]    = getInterpolatedWind(windCache, pressureHpa, tMs);

    const windSpeedMs = Math.sqrt(vx * vx + vy * vy);
    const windDirDeg  = ((Math.atan2(-vx, -vy) * 180) / Math.PI + 360) % 360;

    const sigma = turbulenceSigma(alt);
    turbVz = turbVz * (1 - turbTheta) + (rng() - 0.5) * sigma * Math.sqrt(2 * turbTheta) * 3.5;
    turbVz = Math.max(-3, Math.min(3, turbVz));

    let vertSpeedMs: number;
    if (phase === "ascent") {
      const physRate = ascentRatePhysics(alt, helium_volume_m3, m_total);
      const nearBurstFactor = alt > burst_altitude - 3000
        ? 1 - 0.35 * ((alt - (burst_altitude - 3000)) / 3000)
        : 1;
      vertSpeedMs = Math.max(0.3, physRate * nearBurstFactor + turbVz);
    } else {
      const physRate = descentRatePhysics(alt, parachute_diameter_m, parachute_cd, m_total);
      vertSpeedMs = -(Math.max(0.5, physRate + turbVz));
    }

    const horizSpeedMs = windSpeedMs;
    const totalSpeedMs = Math.sqrt(horizSpeedMs ** 2 + vertSpeedMs ** 2);

    const moveBearing = step === 0
      ? (((Math.atan2(vx, vy) * 180) / Math.PI) + 360) % 360
      : bearingDeg(prevLat, prevLon, lat, lon);

    if (windSpeedMs  > maxWindSpeed)  maxWindSpeed  = windSpeedMs;
    if (horizSpeedMs > maxHorizSpeed) maxHorizSpeed = horizSpeedMs;
    if (totalSpeedMs > maxTotalSpeed) maxTotalSpeed = totalSpeedMs;

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

    [lat, lon] = updatePosition(lat, lon, vx, vy, time_step);

    alt += vertSpeedMs * time_step;

    if (phase === "ascent") {
      if (alt >= burst_altitude) {
        alt = burst_altitude;
        ascentDuration = elapsedSec;
        phase = "descent";
      }
    } else if (alt <= 0) {
      const landTMs = tMs + time_step * 1000;
      const [lx, ly] = getInterpolatedWind(windCache, P0 / 100, landTMs);
      const landWindSpeed = Math.sqrt(lx * lx + ly * ly);
      const landVDesc     = descentRatePhysics(0, parachute_diameter_m, parachute_cd, m_total);
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
        vertical_speed:   -Math.round(landVDesc * 10) / 10,
        total_speed:      Math.round(Math.sqrt(landWindSpeed ** 2 + landVDesc ** 2) * 10) / 10,
        bearing:          bearingDeg(prevLat, prevLon, lat, lon),
      });
      elapsedSec += time_step;
      break;
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

  return { trajectory, landing, stats, balloon_config: balloonConfig, wind_data_fetched_at: windFetchedAt };
}

// ─── Main simulation ──────────────────────────────────────────────────────────

export async function runBalloonSimulation(input: SimulationInput): Promise<SimulationResult> {
  const { latitude, longitude, balloon_mass_g, payload_mass_g, helium_volume_m3, parachute_diameter_m, parachute_cd } = input;

  // Quick lift check before fetching wind
  const m_total = (balloon_mass_g + payload_mass_g) / 1000;
  const quickConfig = calculateBalloonConfig(balloon_mass_g, payload_mass_g, helium_volume_m3, parachute_diameter_m, parachute_cd);
  if (quickConfig.ascent_rate_ms < 0.3) {
    throw new Error(
      `헬륨 부력 부족: 현재 ${helium_volume_m3}m³ 헬륨으로는 ` +
      `${balloon_mass_g}g 풍선 + ${payload_mass_g}g 탑재물을 ` +
      `들어올리기 어렵습니다. 헬륨량을 늘려주세요.`
    );
  }

  const windFetchedAt = new Date().toISOString();
  const windCache     = await fetchWindCache(latitude, longitude);

  return runSimulationCore(input, windCache, windFetchedAt);
}

// ─── Flight Planning (Reverse Optimizer) ─────────────────────────────────────

export interface FlightCase {
  case_number: number;
  label: string;
  description: string;
  strategy: string;
  balloon_mass_g: number;
  helium_volume_m3: number;
  parachute_type: string;
  parachute_diameter_m: number;
  parachute_cd: number;
  distance_to_target_km: number;
  simulation: SimulationResult;
}

export interface PlanInput {
  launch_lat: number;
  launch_lng: number;
  target_lat: number;
  target_lng: number;
  payload_mass_g: number;
  launch_datetime: string;
}

export interface RecommendedWindow {
  datetime: string;          // ISO string
  label: string;             // human-readable e.g. "내일 오전 6시"
  best_distance_km: number;  // best achievable distance at this time
  feasibility: "good" | "marginal" | "infeasible";
}

export interface PlanResult {
  cases: FlightCase[];
  wind_data_fetched_at: string;
  launch_to_target_km: number;
  feasible: boolean;
  feasibility_grade: "good" | "marginal" | "infeasible";
  feasibility_reason: string;
  recommended_windows: RecommendedWindow[];  // top windows sorted by best_distance_km
}

// Search grid definitions
const BALLOON_STRATEGIES = [
  {
    label: "소형 풍선 (빠른 상승)",
    strategy: "fast",
    description: "소형 풍선으로 빠르게 상승, 상층 바람 영향 최소화",
    sizes: [600, 800],
  },
  {
    label: "표준 풍선 (균형형)",
    strategy: "balanced",
    description: "표준 사이즈 풍선으로 균형 잡힌 비행 프로파일",
    sizes: [1000, 1200],
  },
  {
    label: "대형 풍선 (고고도 드리프트)",
    strategy: "highalt",
    description: "대형 풍선으로 높은 고도에서 바람 드리프트 최대 활용",
    sizes: [1500, 2000],
  },
];

const PARACHUTE_CONFIGS = [
  { type: "십자형 (Cross/Cruciform)", diameter: 1.0, cd: 0.97 },
  { type: "십자형 (Cross/Cruciform)", diameter: 1.5, cd: 0.97 },
  { type: "팔각형 (Octagonal)",       diameter: 1.2, cd: 0.85 },
  { type: "팔각형 (Octagonal)",       diameter: 1.5, cd: 0.85 },
  { type: "반구형 (Hemispheric)",     diameter: 1.5, cd: 0.75 },
  { type: "반구형 (Hemispheric)",     diameter: 2.0, cd: 0.75 },
];

const HELIUM_VOLUMES = [1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12];

// ─── Feasibility helpers ──────────────────────────────────────────────────────

function classifyFeasibility(
  bestDistKm: number,
  launchToTargetKm: number
): { grade: "good" | "marginal" | "infeasible"; reason: string } {
  const ratio = launchToTargetKm > 0 ? bestDistKm / launchToTargetKm : 1;

  if (bestDistKm <= Math.max(15, launchToTargetKm * 0.15)) {
    return { grade: "good", reason: `최선의 구성으로 목적지 ${bestDistKm.toFixed(1)} km 이내 착지 가능합니다.` };
  }
  if (bestDistKm <= Math.max(50, launchToTargetKm * 0.4)) {
    return {
      grade: "marginal",
      reason: `현재 바람 패턴으로 정확한 착지가 어렵습니다. 최선의 구성도 목적지에서 ${bestDistKm.toFixed(1)} km 오차가 발생합니다. 다른 날짜를 시도해보세요.`,
    };
  }
  return {
    grade: "infeasible",
    reason: `현재 날짜의 바람 방향이 목적지와 맞지 않아 이론적으로 도달이 어렵습니다. 최선의 구성도 ${bestDistKm.toFixed(1)} km (직선거리의 ${Math.round(ratio * 100)}%) 오차입니다. 아래 추천 날짜를 참고하세요.`,
  };
}

/** Quick single-datetime best-distance estimate (fewer combos for speed) */
function quickBestDistance(
  launch_lat: number,
  launch_lng: number,
  target_lat: number,
  target_lng: number,
  payload_mass_g: number,
  launch_datetime: string,
  windCache: WindCache,
  windFetchedAt: string
): number {
  const QUICK_HE = [2.5, 4, 6, 9] as const;
  const QUICK_PARA = [
    { type: "십자형", diameter: 1.0, cd: 0.97 },
    { type: "팔각형", diameter: 1.5, cd: 0.85 },
    { type: "반구형", diameter: 2.0, cd: 0.75 },
  ];

  let best = Infinity;
  for (const strategy of BALLOON_STRATEGIES) {
    const balloonMassG = strategy.sizes[0]; // just first size per strategy
    for (const para of QUICK_PARA) {
      for (const heVol of QUICK_HE) {
        const m_total = (balloonMassG + payload_mass_g) / 1000;
        const rho0 = P0 / (R * T0);
        const lift_coeff_sl = rho0 - (P0 / (2077 * T0));
        const gross_lift = lift_coeff_sl * heVol * G;
        if (gross_lift - m_total * G < 0.3) continue;
        try {
          const seed = balloonMassG * 1000 + heVol * 100 + para.cd * 10;
          const result = runSimulationCore(
            { latitude: launch_lat, longitude: launch_lng, launch_datetime, balloon_mass_g: balloonMassG, payload_mass_g, helium_volume_m3: heVol, parachute_diameter_m: para.diameter, parachute_cd: para.cd, time_step: 60 },
            windCache, windFetchedAt, seed
          );
          const dist = haversineKm(result.landing.latitude, result.landing.longitude, target_lat, target_lng);
          if (dist < best) best = dist;
        } catch { /* skip */ }
      }
    }
  }
  return best === Infinity ? 9999 : best;
}

/** Korean label for a datetime relative to now */
function koreanTimeLabel(dt: Date, nowMs: number): string {
  const diffH = (dt.getTime() - nowMs) / 3_600_000;
  const hour = dt.getUTCHours();
  const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
  const dayOfWeek = dayNames[dt.getUTCDay()];
  const ampm = hour < 12 ? "오전" : "오후";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  if (diffH < 24) return `오늘 ${ampm} ${h12}시`;
  if (diffH < 48) return `내일 ${ampm} ${h12}시 (${dayOfWeek})`;
  const dayNum = Math.floor(diffH / 24);
  return `${dayNum}일 후 ${ampm} ${h12}시 (${dayOfWeek})`;
}

// ─── Main planFlight ──────────────────────────────────────────────────────────

export async function planFlight(planInput: PlanInput): Promise<PlanResult> {
  const { launch_lat, launch_lng, target_lat, target_lng, payload_mass_g, launch_datetime } = planInput;

  const windFetchedAt = new Date().toISOString();
  const windCache = await fetchWindCache(launch_lat, launch_lng);

  const launchToTargetKm = haversineKm(launch_lat, launch_lng, target_lat, target_lng);

  // ── Full grid search for requested datetime ──────────────────────────────
  const caseResults: FlightCase[] = [];

  for (let stratIdx = 0; stratIdx < BALLOON_STRATEGIES.length; stratIdx++) {
    const strategy = BALLOON_STRATEGIES[stratIdx];
    let bestDist = Infinity;
    let bestCase: FlightCase | null = null;

    for (const balloonMassG of strategy.sizes) {
      for (const para of PARACHUTE_CONFIGS) {
        for (const heVol of HELIUM_VOLUMES) {
          const m_total = (balloonMassG + payload_mass_g) / 1000;
          const rho0 = P0 / (R * T0);
          const lift_coeff_sl = rho0 - (P0 / (2077 * T0));
          const gross_lift = lift_coeff_sl * heVol * G;
          if (gross_lift - m_total * G < 0.5) continue;

          const simInput: SimulationInput = {
            latitude: launch_lat,
            longitude: launch_lng,
            launch_datetime,
            balloon_mass_g: balloonMassG,
            payload_mass_g,
            helium_volume_m3: heVol,
            parachute_diameter_m: para.diameter,
            parachute_cd: para.cd,
            time_step: 60,
          };

          try {
            const seed = balloonMassG * 1000 + heVol * 100 + para.cd * 10;
            const result = runSimulationCore(simInput, windCache, windFetchedAt, seed);
            const dist = haversineKm(
              result.landing.latitude, result.landing.longitude,
              target_lat, target_lng
            );
            if (dist < bestDist) {
              bestDist = dist;
              bestCase = {
                case_number: stratIdx + 1,
                label: strategy.label,
                description: strategy.description,
                strategy: strategy.strategy,
                balloon_mass_g: balloonMassG,
                helium_volume_m3: heVol,
                parachute_type: para.type,
                parachute_diameter_m: para.diameter,
                parachute_cd: para.cd,
                distance_to_target_km: Math.round(dist * 10) / 10,
                simulation: result,
              };
            }
          } catch { /* skip */ }
        }
      }
    }
    if (bestCase) caseResults.push(bestCase);
  }

  caseResults.sort((a, b) => a.distance_to_target_km - b.distance_to_target_km);

  // ── Feasibility ──────────────────────────────────────────────────────────
  const overallBestKm = caseResults.length > 0 ? caseResults[0].distance_to_target_km : 9999;
  const { grade: feasibility_grade, reason: feasibility_reason } = classifyFeasibility(overallBestKm, launchToTargetKm);
  const feasible = feasibility_grade === "good";

  // ── Date scan: try every 6h for 7 days using the same wind cache ─────────
  // Determine the wind cache time range
  const firstLevel = Object.values(windCache)[0];
  const cacheStartMs = firstLevel?.times[0] ?? Date.now();
  const cacheEndMs   = firstLevel?.times[firstLevel.times.length - 1] ?? (Date.now() + 7 * 86_400_000);

  // Candidate datetimes: every 6h starting from now, within cache range
  const nowMs = Date.now();
  const scanStartMs = Math.max(nowMs, cacheStartMs);
  // Round to next 6h boundary
  const step6h = 6 * 3_600_000;
  const firstCandidate = Math.ceil(scanStartMs / step6h) * step6h;

  const rawWindows: RecommendedWindow[] = [];

  for (let tMs = firstCandidate; tMs <= cacheEndMs - 2 * 3_600_000; tMs += step6h) {
    const dt = new Date(tMs);
    const dtISO = dt.toISOString();

    // Skip the requested datetime (already computed above)
    const reqMs = new Date(launch_datetime).getTime();
    if (Math.abs(tMs - reqMs) < step6h / 2) continue;

    const bestKm = quickBestDistance(
      launch_lat, launch_lng, target_lat, target_lng,
      payload_mass_g, dtISO, windCache, windFetchedAt
    );

    const { grade } = classifyFeasibility(bestKm, launchToTargetKm);

    rawWindows.push({
      datetime: dtISO,
      label: koreanTimeLabel(dt, nowMs),
      best_distance_km: Math.round(bestKm * 10) / 10,
      feasibility: grade,
    });
  }

  // Sort by best achievable distance, return top 6
  rawWindows.sort((a, b) => a.best_distance_km - b.best_distance_km);
  const recommended_windows = rawWindows.slice(0, 6);

  return {
    cases: caseResults,
    wind_data_fetched_at: windFetchedAt,
    launch_to_target_km: Math.round(launchToTargetKm * 10) / 10,
    feasible,
    feasibility_grade,
    feasibility_reason,
    recommended_windows,
  };
}
