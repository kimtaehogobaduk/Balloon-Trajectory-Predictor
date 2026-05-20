# 우주풍선 낙하 예측 시뮬레이터

Open-Meteo 상층 기상 API를 실시간으로 연동하여 고고도 풍선의 비행 궤적과 낙하 지점을 예측하는 웹 앱.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API 서버 실행 (port 8080)
- `pnpm --filter @workspace/balloon-simulator run dev` — 프론트엔드 실행 (port 21097)
- `pnpm run typecheck` — 전체 타입체크
- `pnpm run build` — 전체 빌드

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19 + Vite, react-leaflet, TanStack Query
- API: Express 5
- Validation: Zod (`zod/v4`), Orval codegen
- Map: Leaflet (CartoDB dark tiles)
- Wind Data: Open-Meteo Upper Air API (free, no key required)

## Where things live

- `lib/api-spec/openapi.yaml` — API 스펙 (source of truth)
- `lib/api-client-react/src/generated/` — Orval 생성 React Query 훅
- `lib/api-zod/src/generated/` — Orval 생성 Zod 스키마
- `artifacts/api-server/src/lib/balloonSimulator.ts` — 핵심 물리 시뮬레이션 엔진
- `artifacts/api-server/src/routes/simulation.ts` — /simulate, /presets 라우트
- `artifacts/balloon-simulator/src/pages/home.tsx` — 메인 시뮬레이터 UI
- `artifacts/balloon-simulator/src/components/Map.tsx` — Leaflet 지도 컴포넌트

## Architecture decisions

- Open-Meteo API는 API 서버에서만 호출 (백엔드 프록시) — CORS 문제 방지 및 향후 캐싱 확장 용이
- 풍선 물리 모델: ISA 표준 대기 2계층 모델 (대류권 lapse rate + 성층권 등온)
- 기압 레벨 매핑: 10개 레벨 [1000, 925, 850, 700, 500, 300, 200, 100, 50, 10 hPa] 중 최근접 레벨 선택
- 프리셋 4종 내장: 한국 표준, 초고층 탐사, 고속 상승, 저속 장거리

## Product

- 발사 위치(위/경도), 발사 시각, 상승 속도, 버스트 고도, 낙하 속도 입력
- 실시간 Open-Meteo 기상 데이터 수신 후 1분 단위 궤적 시뮬레이션 실행
- 지도에 상승 경로(파랑), 하강 경로(주황), 발사지/버스트 포인트/낙하지 마커 표시
- 비행 통계(총 비행 시간, 최대 고도, 최대 풍속, 수평 이동 거리) 표시
- 궤적 데이터 테이블(접기/펼치기 가능)

## Gotchas

- react-leaflet 4.x는 React ^18 peer dep 선언이지만 React 19에서도 동작함
- Open-Meteo는 무료 키 없는 API (forecast_days=3, UTC timezone)
- 시뮬레이션 루프는 최대 100,000 스텝 제한 (무한루프 방지)
- 백엔드에서 fetch() 사용 — Node 24 native fetch, 별도 패키지 불필요

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
