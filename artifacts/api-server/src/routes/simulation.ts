import { Router } from "express";
import { RunSimulationBody } from "@workspace/api-zod";
import { runBalloonSimulation, planFlight } from "../lib/balloonSimulator";
import type { SimulationInput, PlanInput } from "../lib/balloonSimulator";
import * as z from "zod";

const router = Router();

// ─── Presets ──────────────────────────────────────────────────────────────────

const PRESETS = [
  {
    id: "korea-standard",
    name: "한국 표준 기상 탐사",
    description: "서울 기준 1000g 풍선, 4m³ 헬륨, 1.5m 십자 낙하산 — 계산 버스트 고도 약 33km",
    config: {
      latitude:              37.5665,
      longitude:             126.978,
      launch_datetime:       new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16) + ":00Z",
      balloon_mass_g:        1000,
      payload_mass_g:        500,
      helium_volume_m3:      4.0,
      parachute_diameter_m:  1.5,
      parachute_cd:          0.97,
      time_step:             60,
    },
  },
  {
    id: "high-altitude",
    name: "초고층 탐사 (38km+)",
    description: "부산 기준 2000g 대형 풍선, 소량 헬륨으로 서서히 상승 — 계산 버스트 고도 약 38km",
    config: {
      latitude:              35.1796,
      longitude:             129.0756,
      launch_datetime:       new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16) + ":00Z",
      balloon_mass_g:        2000,
      payload_mass_g:        300,
      helium_volume_m3:      3.5,
      parachute_diameter_m:  2.0,
      parachute_cd:          0.97,
      time_step:             60,
    },
  },
  {
    id: "fast-ascent",
    name: "고속 상승 단기 미션",
    description: "대전 기준 600g 소형 풍선, 6m³ 헬륨으로 빠른 상승 — 약 26km에서 버스트",
    config: {
      latitude:              36.3504,
      longitude:             127.3845,
      launch_datetime:       new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16) + ":00Z",
      balloon_mass_g:        600,
      payload_mass_g:        400,
      helium_volume_m3:      6.0,
      parachute_diameter_m:  1.2,
      parachute_cd:          0.97,
      time_step:             30,
    },
  },
  {
    id: "slow-float",
    name: "저속 장거리 드리프트",
    description: "강릉 기준 1500g 풍선, 적은 헬륨으로 2m/s 이하 초저속 상승 — 바람에 충분히 실림",
    config: {
      latitude:              37.8228,
      longitude:             128.1555,
      launch_datetime:       new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16) + ":00Z",
      balloon_mass_g:        1500,
      payload_mass_g:        300,
      helium_volume_m3:      2.0,
      parachute_diameter_m:  2.0,
      parachute_cd:          0.97,
      time_step:             60,
    },
  },
];

// ─── Plan input schema ────────────────────────────────────────────────────────

const PlanBody = z.object({
  launch_lat:      z.number().min(-90).max(90),
  launch_lng:      z.number().min(-180).max(180),
  target_lat:      z.number().min(-90).max(90),
  target_lng:      z.number().min(-180).max(180),
  payload_mass_g:  z.number().min(0).max(10000),
  launch_datetime: z.string().min(1),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/presets", (_req, res) => {
  res.json(PRESETS);
});

router.post("/simulate", async (req, res) => {
  const parsed = RunSimulationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const input: SimulationInput = {
    latitude:              parsed.data.latitude,
    longitude:             parsed.data.longitude,
    launch_datetime:       parsed.data.launch_datetime,
    balloon_mass_g:        parsed.data.balloon_mass_g,
    payload_mass_g:        parsed.data.payload_mass_g,
    helium_volume_m3:      parsed.data.helium_volume_m3,
    parachute_diameter_m:  parsed.data.parachute_diameter_m,
    parachute_cd:          parsed.data.parachute_cd,
    time_step:             parsed.data.time_step ?? 60,
  };

  try {
    const result = await runBalloonSimulation(input);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Simulation failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Open-Meteo")) {
      res.status(502).json({ error: `바람 데이터 수신 실패: ${message}` });
    } else if (message.includes("헬륨") || message.includes("부력")) {
      res.status(400).json({ error: message });
    } else {
      res.status(500).json({ error: `시뮬레이션 오류: ${message}` });
    }
  }
});

router.post("/plan", async (req, res) => {
  const parsed = PlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const input: PlanInput = {
    launch_lat:      parsed.data.launch_lat,
    launch_lng:      parsed.data.launch_lng,
    target_lat:      parsed.data.target_lat,
    target_lng:      parsed.data.target_lng,
    payload_mass_g:  parsed.data.payload_mass_g,
    launch_datetime: parsed.data.launch_datetime,
  };

  try {
    const result = await planFlight(input);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Planning failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Open-Meteo")) {
      res.status(502).json({ error: `바람 데이터 수신 실패: ${message}` });
    } else {
      res.status(500).json({ error: `경로 계획 오류: ${message}` });
    }
  }
});

export default router;
