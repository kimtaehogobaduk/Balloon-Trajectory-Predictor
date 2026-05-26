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
 *
 * - Fill radius comes directly from helium_volume_m3 (no Newton-Raphson needed).
 * - Ascent rate at sea level is the terminal velocity of the force balance.
 * - Burst altitude is binary-searched where V(h) = V_burst.
 * - Descent rate at sea level uses parachute drag physics.
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
  const rho_He0   = P0 / (RHO_HE_SL > 0 ? (2077 * T0) : 1); // use formula consistently
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

/**
 * Terminal ascent rate at altitude h given sea-level helium fill volume.
 *
 * At each altitude h the balloon volume expands:
 *   V(h) = V_fill × (P₀/P(h)) × (T(h)/T₀)   [ideal gas]
 *
 * Net force balance → terminal velocity:
 *   (ρ_air − ρ_He) × V × g − m_total × g = ½ C_D ρ_air π r² v²
 *   v_t = √( F_net / (½ C_D ρ_air π r²) )
 */
function ascentRatePhysics(h: number, V_fill_sl: number, m_total: number): number {
  const P       = altitudeToPressure(Math.max(h, 0));
  const T       = isaTemperature(Math.max(h, 0));
  const rho_air = P / (R * T);
  const rho_He  = P / (R_HE * T);

  const expansion = (P0 / P) * (T / T0);
  const V   = V_fill_sl * expansion;
  const r   = Math.cbrt(3 * V / (4 * Math.PI));

  const net_force = (rho_air - rho_He) * V * G - m_total * G;
  if (net_force <= 0) return 0.3; // neutral / negative buoyancy

  const drag_denom = 0.5 * C_D_BALLOON * rho_air * Math.PI * r * r;
  return Math.min(50, Math.sqrt(net_force / drag_denom));
}

/**
 * Parachute terminal descent speed (magnitude) at altitude h.
 *
 *   ½ C_D ρ_air(h) A v² = m_total g
 *   v(h) = √( 2 m g / (C_D ρ_air(h) A) )
 *
 * Capped at 150 m/s to avoid hypersonic regime where this model breaks down.
 */
function descentRatePhysics(h: number, parachuteDiamM: number, parachuteCd: number, m_total: number): number {
  const P       = altitudeToPressure(Math.max(h, 0));
  const T       = isaTemperature(Math.max(h, 0));
  const rho_air = P / (R * T);
  const A_chute = Math.PI * (parachuteDiamM / 2) ** 2;
  return Math.min(150, Math.sqrt(2 * m_total * G / (parachuteCd * rho_air * A_chute)));
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

// ─── Main simulation ──────────────────────────────────────────────────────────

export async function runBalloonSimulation(input: SimulationInput): Promise<SimulationResult> {
  const {
    latitude, longitude, launch_datetime,
    balloon_mass_g, payload_mass_g,
    helium_volume_m3, parachute_diameter_m, parachute_cd,
    time_step = 60,
  } = input;

  const m_total = (balloon_mass_g + payload_mass_g) / 1000; // kg

  // ── Derive all balloon parameters from physical inputs ──────────────────────
  const balloonConfig  = calculateBalloonConfig(
    balloon_mass_g, payload_mass_g, helium_volume_m3, parachute_diameter_m, parachute_cd
  );
  const burst_altitude = balloonConfig.burst_altitude_m;

  // ── Guard: minimum lift check ───────────────────────────────────────────────
  if (balloonConfig.ascent_rate_ms < 0.3) {
    throw new Error(
      `헬륨 부력 부족: 현재 ${helium_volume_m3}m³ 헬륨으로는 ` +
      `${balloon_mass_g}g 풍선 + ${payload_mass_g}g 탑재물을 ` +
      `들어올리기 어렵습니다. 헬륨량을 늘려주세요.`
    );
  }

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

    // ── Vertical speed: full per-step balloon/parachute physics ──────────────
    let vertSpeedMs: number;
    if (phase === "ascent") {
      // Full force balance per step — accounts for balloon expansion & density change
      const physRate = ascentRatePhysics(alt, helium_volume_m3, m_total);
      // Near burst: overinflation adds drag (latex stretch resistance)
      const nearBurstFactor = alt > burst_altitude - 3000
        ? 1 - 0.35 * ((alt - (burst_altitude - 3000)) / 3000)
        : 1;
      vertSpeedMs = Math.max(0.3, physRate * nearBurstFactor + turbVz);
    } else {
      // Parachute: terminal velocity = √(2mg / (C_D ρ(h) A)) — fast at altitude
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
