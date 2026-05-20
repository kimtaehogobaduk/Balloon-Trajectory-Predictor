import { Router } from "express";
import { RunSimulationBody } from "@workspace/api-zod";
import { runBalloonSimulation } from "../lib/balloonSimulator";
import type { SimulationInput } from "../lib/balloonSimulator";

const router = Router();

// ─── Presets ──────────────────────────────────────────────────────────────────

const PRESETS = [
  {
    id: "korea-standard",
    name: "한국 표준 기상 탐사",
    description: "서울 기준 일반적인 고층 기상 관측 풍선 설정",
    config: {
      latitude: 37.5665,
      longitude: 126.978,
      launch_datetime: new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16) + ":00Z",
      ascent_rate: 5.0,
      burst_altitude: 30000,
      descent_rate: 6.0,
      time_step: 60,
    },
  },
  {
    id: "high-altitude",
    name: "초고층 탐사 (30km+)",
    description: "성층권 진입을 목표로 한 고고도 기상 탐사 설정",
    config: {
      latitude: 35.1796,
      longitude: 129.0756,
      launch_datetime: new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16) + ":00Z",
      ascent_rate: 4.0,
      burst_altitude: 38000,
      descent_rate: 5.5,
      time_step: 60,
    },
  },
  {
    id: "fast-ascent",
    name: "고속 상승 단기 미션",
    description: "빠른 상승으로 단시간 내 버스트, 좁은 낙하 범위 예측",
    config: {
      latitude: 36.3504,
      longitude: 127.3845,
      launch_datetime: new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16) + ":00Z",
      ascent_rate: 8.0,
      burst_altitude: 25000,
      descent_rate: 8.0,
      time_step: 30,
    },
  },
  {
    id: "slow-float",
    name: "저속 장거리 드리프트",
    description: "느린 상승으로 바람에 충분히 실려 원거리 낙하점 탐색",
    config: {
      latitude: 37.8228,
      longitude: 128.1555,
      launch_datetime: new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16) + ":00Z",
      ascent_rate: 2.5,
      burst_altitude: 32000,
      descent_rate: 4.0,
      time_step: 60,
    },
  },
];

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
    latitude: parsed.data.latitude,
    longitude: parsed.data.longitude,
    launch_datetime: parsed.data.launch_datetime,
    ascent_rate: parsed.data.ascent_rate,
    burst_altitude: parsed.data.burst_altitude,
    descent_rate: parsed.data.descent_rate,
    time_step: parsed.data.time_step ?? 60,
  };

  try {
    const result = await runBalloonSimulation(input);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Simulation failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Open-Meteo")) {
      res.status(502).json({ error: `바람 데이터 수신 실패: ${message}` });
    } else {
      res.status(500).json({ error: `시뮬레이션 오류: ${message}` });
    }
  }
});

export default router;
