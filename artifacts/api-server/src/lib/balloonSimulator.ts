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
  fill_diameter_m:  number;
  burst_diameter_m: number;
  burst_altitude_m: number;
  neck_lift_n:      number;
  volume_fill_m3:   number;
}

/**
 * Given balloon mass, payload mass, and target sea-level ascent rate,
 * returns the theoretical balloon configuration (fill size + burst altitude).
 *
 * Force balance at sea-level terminal ascent velocity v₀:
 *   (ρ_air − ρ_He) × V × g  =  m_total × g  +  ½ C_D ρ_air π r² v₀²
 * → cubic in fill radius r, solved by Newton-Raphson.
 *
 * Burst altitude: binary search for h where
 *   (P₀/P(h)) × (T(h)/T₀)  =  V_burst / V_fill
 */
export function calculateBalloonConfig(
  balloonMassG: number,
  payloadMassG: number,
  ascentRateMs: number
): BalloonConfig {
  const m_balloon  = balloonMassG  / 1000; // kg
  const m_payload  = payloadMassG  / 1000; // kg
  const m_total    = m_balloon + m_payload;
  const v0         = ascentRateMs;

  // Sea-level air density from ISA constants
  const rho0       = P0 / (R * T0); // ≈ 1.225 kg/m³
  const lift_coeff = rho0 - RHO_HE_SL; // ≈ 1.056 kg/m³ net specific lift

  // Burst geometry
  const d_burst  = burstDiameter(m_balloon);
  const r_burst  = d_burst / 2;
  const V_burst  = (4 / 3) * Math.PI * r_burst ** 3;

  // Drag coefficient (for ascent force balance)
  const drag_k   = 0.5 * C_D_BALLOON * rho0 * Math.PI; // × r² × v₀²

  // Newton-Raphson on f(r) = (4/3)π·lift_coeff·r³ - drag_k·r²·v₀² - m_total·g = 0
  const A        = (4 / 3) * Math.PI * lift_coeff * G;
  const B        = drag_k * v0 * v0;
  const C        = m_total * G;

  // Initial guess: radius from pure buoyancy (no drag)
  let r = Math.cbrt((3 * C) / (4 * Math.PI * lift_coeff * G));
  for (let i = 0; i < 50; i++) {
    const f  = A * r ** 3 - B * r ** 2 - C;
    const df = 3 * A * r ** 2 - 2 * B * r;
    if (Math.abs(df) < 1e-12) break;
    const dr = f / df;
    r -= dr;
    if (Math.abs(dr) < 1e-9) break;
  }
  r = Math.max(r, 0.3); // floor at 30 cm

  const V_fill  = (4 / 3) * Math.PI * r ** 3;
  const neck_lift = (lift_coeff * V_fill - m_total) * G; // N (net upward)

  // Burst altitude: find h where expansion ratio = V_burst/V_fill
  const expTarget = V_burst / V_fill;
  let hLo = 0, hHi = 60000;
  for (let i = 0; i < 60; i++) {
    const hMid = (hLo + hHi) / 2;
    const P    = altitudeToPressure(hMid);
    const T    = isaTemperature(hMid);
    const expH = (P0 / P) * (T / T0);
    if (expH < expTarget) hLo = hMid;
    else                  hHi = hMid;
  }
  const burst_alt = (hLo + hHi) / 2;

  return {
    fill_diameter_m:  Math.round(r * 2 * 1000) / 1000,
    burst_diameter_m: Math.round(d_burst * 1000) / 1000,
    burst_altitude_m: Math.round(burst_alt),
    neck_lift_n:      Math.round(neck_lift * 100) / 100,
    volume_fill_m3:   Math.round(V_fill * 1000) / 1000,
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

/**
 * Effective ascent rate at altitude h.
 *
 * Physical derivation:
 *   – Net lift (buoyancy − weight) is approximately constant throughout flight
 *     because ρ_air × V ≈ const (gas mass conserved, volume ∝ 1/ρ_air).
 *   – Drag ∝ ρ_air(h) × A(h) × v², and A(h) ∝ V(h)^(2/3) ∝ ρ_air(h)^(−2/3).
 *   – At terminal velocity: F_net = F_drag → v ∝ ρ_air(h)^(−1/6).
 *
 * Result: ascent rate roughly doubles from sea level to ~30 km.
 */
function effectiveAscentRate(h: number, v0: number): number {
  return v0 * Math.pow(RHO_0 / airDensity(h), 1 / 6);
}

/**
 * Effective descent rate (magnitude) at altitude h.
 *
 * Physical derivation:
 *   Parachute terminal velocity: F_drag = m·g
 *   0.5 × C_D × ρ_air(h) × A × v² = m·g
 *   → v(h) = v_ground × √(ρ₀ / ρ_air(h))
 *
 * Capped at 90 m/s (hypersonic would require different model).
 * At 30 km: typical descent ≈ 6 × √(68) ≈ 50 m/s.
 */
function effectiveDescentRate(h: number, v0: number): number {
  return Math.min(v0 * Math.sqrt(RHO_0 / airDensity(h)), 90);
}

/**
 * Turbulence sigma (m/s) by atmospheric layer:
 *   0–3 km    : moderate convective turbulence
 *   3–12 km   : stronger, tropopause / jet-stream region
 *   12–20 km  : stratosphere lower, mostly smooth
 *   >20 km    : very calm
 */
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
  balloon_config: BalloonConfig;
  wind_data_fetched_at: string;
}

export interface SimulationInput {
  latitude: number;
  longitude: number;
  launch_datetime: string;
  balloon_mass_g: number;
  payload_mass_g: number;
  ascent_rate: number;
  descent_rate: number;
  time_step?: number;
}

// ─── Main simulation ──────────────────────────────────────────────────────────

export async function runBalloonSimulation(input: SimulationInput): Promise<SimulationResult> {
  const { latitude, longitude, launch_datetime, balloon_mass_g, payload_mass_g, ascent_rate, descent_rate, time_step = 60 } = input;

  // ── Derive burst altitude from balloon physics ──────────────────────────────
  const balloonConfig  = calculateBalloonConfig(balloon_mass_g, payload_mass_g, ascent_rate);
  const burst_altitude = balloonConfig.burst_altitude_m;

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

  // Ornstein-Uhlenbeck turbulent vertical velocity (m/s)
  // Mean-reversion coefficient θ chosen so correlation time ≈ 5 × time_step
  let turbVz = 0;
  const turbTheta = 1 - Math.exp(-1 / 5); // ≈ 0.18 for 5-step correlation

  for (let step = 0; step < MAX_STEPS; step++) {
    const tMs         = launchMs + elapsedSec * 1000;
    const pressurePa  = altitudeToPressure(Math.max(alt, 0));
    const pressureHpa = pressurePa / 100;
    const [vx, vy]    = getInterpolatedWind(windCache, pressureHpa, tMs);

    const windSpeedMs = Math.sqrt(vx * vx + vy * vy);
    const windDirDeg  = ((Math.atan2(-vx, -vy) * 180) / Math.PI + 360) % 360;

    // ── Turbulence: Ornstein-Uhlenbeck step ──────────────────────────────────
    // dV = −θ·V·dt + σ·√(2θ)·dW   (discrete: V ← V·(1−θ) + noise)
    const sigma = turbulenceSigma(alt);
    turbVz = turbVz * (1 - turbTheta) + (Math.random() - 0.5) * sigma * Math.sqrt(2 * turbTheta) * 3.5;
    turbVz = Math.max(-3, Math.min(3, turbVz)); // hard clamp

    // ── Vertical speed: physics-based, not constant ───────────────────────────
    let vertSpeedMs: number;
    if (phase === "ascent") {
      // Effective rate rises with altitude (lower air density → less drag)
      const physRate = effectiveAscentRate(alt, ascent_rate);
      // Near burst: extra overinflation drag slows the balloon
      const nearBurstFactor = alt > burst_altitude - 3000
        ? 1 - 0.35 * ((alt - (burst_altitude - 3000)) / 3000)
        : 1;
      vertSpeedMs = Math.max(0.3, physRate * nearBurstFactor + turbVz);
    } else {
      // Parachute: fast at altitude, slows dramatically near ground
      const physRate = effectiveDescentRate(alt, descent_rate);
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

    // ── Altitude update ───────────────────────────────────────────────────────
    alt += vertSpeedMs * time_step;

    if (phase === "ascent") {
      if (alt >= burst_altitude) {
        alt = burst_altitude;
        ascentDuration = elapsedSec;
        phase = "descent";
      }
    } else if (alt <= 0) {
      // Final landing point snapshot
      const landTMs = tMs + time_step * 1000;
      const [lx, ly] = getInterpolatedWind(windCache, P0 / 100, landTMs);
      const landWindSpeed = Math.sqrt(lx * lx + ly * ly);
      const landVDesc     = effectiveDescentRate(0, descent_rate);
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
