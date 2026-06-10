# 우주풍선 낙하 예측 시뮬레이터 — 기능 상세 보고서

> **앱 주소**: https://balloon-simulator.replit.app  
> **버전**: Flight Planning Tool v2.0  
> **작성일**: 2026-06-10  
> **기술 스택**: React + Vite (프론트), Node.js + Express (API), Three.js, Leaflet, Recharts

---

## 목차

1. [앱 개요](#1-앱-개요)
2. [시스템 아키텍처](#2-시스템-아키텍처)
3. [핵심 물리 엔진](#3-핵심-물리-엔진)
4. [기능 1 — 시뮬레이션 모드](#4-기능-1--시뮬레이션-모드)
5. [기능 2 — 역방향 비행 계획](#5-기능-2--역방향-비행-계획)
6. [기능 3 — 2D / 3D 지도 뷰](#6-기능-3--2d--3d-지도-뷰)
7. [기능 4 — 비행 애니메이션 플레이어](#7-기능-4--비행-애니메이션-플레이어)
8. [기능 5 — 3D 경로 뷰어 (Route3D)](#8-기능-5--3d-경로-뷰어-route3d)
9. [기능 6 — 실시간 물리 미리보기](#9-기능-6--실시간-물리-미리보기)
10. [기능 7 — 비행 텔레메트리 및 차트](#10-기능-7--비행-텔레메트리-및-차트)
11. [기능 8 — 프리셋 시나리오](#11-기능-8--프리셋-시나리오)
12. [기능 9 — 지도 클릭으로 좌표 입력](#12-기능-9--지도-클릭으로-좌표-입력)
13. [기능 10 — 탄도 로그 테이블](#13-기능-10--탄도-로그-테이블)
14. [API 엔드포인트 정의](#14-api-엔드포인트-정의)
15. [데이터 흐름 전체 다이어그램](#15-데이터-흐름-전체-다이어그램)

---

## 1. 앱 개요

**우주풍선 낙하 예측 시뮬레이터**는 고고도 기상 탐사 풍선(HAB, High-Altitude Balloon)의 전체 비행 궤적을 물리 법칙 기반으로 예측하는 웹 애플리케이션입니다. 단순한 착지점 계산을 넘어, **역방향 비행 계획**(원하는 착지점에 도달하기 위한 최적 구성 탐색), **실시간 3D 경로 시각화**, **7일치 실측 바람 데이터** 연동까지 지원합니다.

주요 사용 목적:
- 기상 탐사 풍선 발사 전 착지 예측
- 특정 장소에 카메라·센서 탑재 풍선을 착지시키기 위한 역산 설계
- 대기 상층부 바람 패턴 시각화

---

## 2. 시스템 아키텍처

```
┌─────────────────────────────────────────┐
│           브라우저 (React + Vite)         │
│  ┌───────────────┐  ┌───────────────┐   │
│  │  시뮬레이션 UI  │  │  역방향 계획 UI │   │
│  └───────┬───────┘  └───────┬───────┘   │
│          │                  │           │
│  ┌───────▼──────────────────▼───────┐   │
│  │     @workspace/api-client-react   │   │
│  │  (TanStack Query + 자동 생성 훅)  │   │
│  └───────────────┬───────────────────┘   │
└─────────────────│───────────────────────┘
                  │ HTTP/JSON
┌─────────────────▼───────────────────────┐
│         API 서버 (Express + Pino)         │
│  POST /api/simulate  POST /api/plan      │
│  GET  /api/presets                       │
│  ┌─────────────────────────────────┐    │
│  │       balloonSimulator.ts        │    │
│  │  ISA 대기 / 바람 보간 / 물리 적분 │    │
│  └──────────────┬──────────────────┘    │
└─────────────────│───────────────────────┘
                  │ HTTPS
┌─────────────────▼───────────────────────┐
│   Open-Meteo API (무료, 공개)             │
│   10개 기압면 × 7일 바람 데이터 (hourly) │
└─────────────────────────────────────────┘
```

| 레이어 | 역할 | 기술 |
|--------|------|------|
| 프론트엔드 | UI 렌더링, 상태관리, 지도, 3D | React 18, Vite, TanStack Query, Leaflet, Three.js |
| API 서버 | 물리 계산, 외부 API 프록시 | Node.js, Express, esbuild 번들 |
| 공유 라이브러리 | 타입 정의, API 훅 자동 생성 | `@workspace/api-client-react`, Zod |
| 외부 데이터 | 실측 바람 데이터 | Open-Meteo 무료 예보 API |

---

## 3. 핵심 물리 엔진

파일: `artifacts/api-server/src/lib/balloonSimulator.ts`

### 3.1 ICAO 표준 대기 모델 (5층 구조)

```
층   | 고도(m)       | 기온감률(K/m) | 설명
0   | 0 ~ 11,000   | -0.0065      | 대류권 (Troposphere)
1   | 11,000~20,000| 0 (등온)     | 성층권 하부 (Tropopause)
2   | 20,000~32,000| +0.001       | 성층권 중부
3   | 32,000~47,000| +0.0028      | 성층권 상부
4   | 47,000~      | 0 (등온)     | 중간권 하부 (Stratopause)
```

ISA 압력 계산 공식:
- **등온층**: `P = P_base × exp(-G × Δh / (R × T_base))`
- **기온감률층**: `P = P_base × (T_base / T)^(G / R / L)`

여기서 G = 9.80665 m/s², R = 287.05 J/(kg·K), L = 기온감률

### 3.2 풍선 팽창 물리

풍선은 고도가 높아질수록 외부 기압이 낮아져 **등압 팽창**합니다.

```
V(h) = V_fill × (P0 / P(h)) × (T(h) / T0)
```

- `V_fill`: 지상 충진 부피 (m³, 헬륨 주입량)
- `P0`, `T0`: 해수면 기압/기온
- `P(h)`, `T(h)`: 고도 h에서의 ISA 기압/기온

**버스트 고도** 계산: 풍선 제조사 데이터를 피팅한 경험 공식으로 질량별 최대 직경을 결정하고, 팽창 부피가 그 최대 부피에 도달하는 고도를 이진 탐색으로 계산합니다.

```
d_burst = 4.5 × (m_balloon_kg / 0.1)^0.30   [m]
```

| 풍선 질량 | 버스트 직경 | 버스트 고도(예시, 4m³) |
|-----------|------------|----------------------|
| 100g      | ~4.5 m     | ~20 km               |
| 600g      | ~7.5 m     | ~26 km               |
| 1000g     | ~9.0 m     | ~33 km               |
| 2000g     | ~11.3 m    | ~38 km               |

### 3.3 상승 속도 계산

헬륨의 부력(부양력) - 중력 = 순 상방향 힘, 여기서 항력과 균형을 이루는 속도:

```
v_ascent = √[ (ρ_air - ρ_He) × V(h) × G - m_total × G ]
            ─────────────────────────────────────────────
                   0.5 × C_D_ball × ρ_air × π × r²
```

- `ρ_air`: ISA 공기 밀도 (고도에 따라 변함)
- `ρ_He`: 헬륨 밀도 = P / (R_He × T), R_He = 2077 J/(kg·K)
- `C_D_ball` = 0.47 (구형 항력 계수)
- `r`: 고도에서의 풍선 반지름

**버스트 직전 감속**: 버스트 고도 3km 전부터 선형적으로 35% 감속 (실제 팽창 응력에 의한 형태 변형 반영)

### 3.4 하강 속도 계산

낙하산의 항력과 중력이 균형을 이루는 종단속도:

```
v_descent = √[ 2 × m_total × G / (C_D × ρ_air × A_chute) ]
```

- `C_D`: 낙하산 형태별 항력 계수 (십자형 0.97, 반구형 0.75 등)
- `A_chute = π × (d/2)²`: 낙하산 면적
- 고도가 높을수록 `ρ_air`가 작아 하강 속도가 빨라짐 (성층권에서 최대 수백 m/s 초기 하강 → 저층에서 ~5–8 m/s로 감속)

### 3.5 난류 모델 (Ornstein-Uhlenbeck 프로세스)

실제 대기 난류를 모사하기 위한 확률적 수직 속도 성분:

```
turbVz ← turbVz × (1 - θ) + noise × σ(h) × √(2θ) × 3.5
```

- `θ = 1 - exp(-1/5)`: 감쇠 계수 (5스텝 상관 시간)
- `σ(h)`: 고도별 난류 강도
  - 0 ~ 3 km: σ = 0.42 (경계층 난류)
  - 3 ~ 12 km: σ = 0.80 (제트 스트림 영역)
  - 12 ~ 20 km: σ = 0.20 (성층권 하부)
  - 20 km+: σ = 0.08 (매우 안정적)

### 3.6 바람 데이터 취득 및 보간

**데이터 소스**: Open-Meteo API (무료, 등록 불필요)

```
GET https://api.open-meteo.com/v1/forecast
  ?latitude={lat}&longitude={lng}
  &hourly=windspeed_1000hPa,winddirection_1000hPa,...,windspeed_10hPa,winddirection_10hPa
  &wind_speed_unit=ms
  &forecast_days=7
  &timezone=UTC
```

취득 기압면 (10개):
`1000, 925, 850, 700, 500, 300, 200, 100, 50, 10 hPa`

**시간 보간**: 각 기압면에서 인접한 두 시간대 사이를 선형 보간
```
v(t) = v_lo + (t - t_lo) / (t_hi - t_lo) × (v_hi - v_lo)
```

**수직 보간**: 임의 기압에서의 바람을 log-압력 공간 선형 보간으로 계산
```
weight = (ln(P) - ln(P_low)) / (ln(P_high) - ln(P_low))
v = v_low + weight × (v_high - v_low)
```

log-압력 공간을 쓰는 이유: 고도에 따른 기압 변화가 지수적이므로, log 공간에서 보간하면 실제 대기 수직 구조를 더 정확히 반영합니다.

### 3.7 위치 적분 (Runge-Kutta 1차 = 오일러법)

매 time_step(기본 60초)마다:

```
lat_new = lat + (vy × dt × 180) / (π × R_Earth)
lon_new = lon + (vx × dt × 180) / (π × R_Earth × cos(lat × π/180))
alt_new = alt + v_vertical × dt
```

- `vx`, `vy`: 동서/남북 바람 성분 (m/s)
- cos(lat) 보정: 위도가 높을수록 경도 1도의 실제 거리가 짧아지는 것을 보정

---

## 4. 기능 1 — 시뮬레이션 모드

### 화면 위치
좌측 사이드바 → "시뮬레이션" 탭

### 입력 파라미터

| 파라미터 | 단위 | 설명 |
|----------|------|------|
| Latitude | °N   | 발사 위도 (-90 ~ +90) |
| Longitude | °E  | 발사 경도 (-180 ~ +180) |
| Launch Datetime | 로컬 시각 | 발사 일시 (datetime-local) |
| Balloon Size | g   | 풍선 질량 (100 ~ 3000g, 10종) |
| Helium Volume | m³  | 헬륨 주입량 (0.1 ~ 500 m³) |
| Payload | g   | 탑재물 질량 (0 ~ 10,000g) |
| Time Step | s   | 적분 시간 간격 (1 ~ 300초) |
| Canopy Type | —   | 낙하산 형태 (4종) |
| Parachute Diameter | m | 낙하산 직경 (0.2 ~ 10 m) |
| Drag Coeff C_D | — | 항력 계수 (0.3 ~ 1.5) |

### 낙하산 종류

| 종류 | C_D |
|------|-----|
| 십자형 (Cross/Cruciform) | 0.97 |
| 팔각형 (Octagonal) | 0.85 |
| 반구형 (Hemispheric) | 0.75 |
| 평면원형 (Flat Circular) | 0.75 |

### 처리 흐름

```
사용자 제출
    ↓
Zod 스키마 유효성 검사 (프론트)
    ↓
POST /api/simulate (JSON)
    ↓
서버: 빠른 부력 체크 (wind fetch 전)
    ↓
Open-Meteo API 호출 (최대 15초 타임아웃)
    ↓
runSimulationCore() — 오일러 적분 루프 (최대 100,000스텝)
    ↓
SimulationResult JSON 반환
    ↓
지도 경로 렌더링 + 텔레메트리 표시
```

### 출력 결과 (`SimulationResult`)

```typescript
{
  trajectory: TrajectoryPoint[],   // 전체 경로 포인트 배열
  landing: TrajectoryPoint,        // 최종 착지점
  stats: {
    total_duration_seconds,        // 총 비행 시간
    ascent_duration_seconds,       // 상승 구간 시간
    descent_duration_seconds,      // 하강 구간 시간
    max_altitude,                  // 최고 고도 (m)
    max_wind_speed,                // 최대 풍속 (m/s)
    max_horizontal_speed,          // 최대 수평 속도
    max_total_speed,               // 최대 합성 속도
    total_distance_km,             // 총 이동 거리 (km, 경로 합산)
    horizontal_drift_km,           // 수평 직선 이동 거리
  },
  balloon_config: {
    fill_diameter_m,               // 지상 충진 직경
    burst_diameter_m,              // 버스트 직경
    burst_altitude_m,              // 예측 버스트 고도
    neck_lift_n,                   // 순 부양력 (N)
    ascent_rate_ms,                // 해수면 기준 상승 속도
    descent_rate_sl_ms,            // 해수면 기준 하강 속도
  },
  wind_data_fetched_at: string     // 바람 데이터 취득 시각
}
```

각 `TrajectoryPoint`:

```typescript
{
  time: string,             // ISO 시각
  latitude, longitude,      // 위치 (°)
  altitude,                 // 고도 (m)
  phase: "ascent" | "descent",
  wind_speed,               // 풍속 (m/s)
  wind_direction,           // 풍향 (°, 기상 관례)
  pressure_hpa,             // 기압 (hPa)
  horizontal_speed,         // 수평 속도
  vertical_speed,           // 수직 속도 (양수=상승)
  total_speed,              // 합성 속도
  bearing,                  // 이동 방향 (°)
}
```

---

## 5. 기능 2 — 역방향 비행 계획

### 화면 위치
좌측 사이드바 → "역방향 계획" 탭

### 개념
일반 시뮬레이션이 "이 설정으로 발사하면 어디 떨어지나?"를 구하는 **순방향**이라면, 역방향 계획은 "**특정 장소에 떨어뜨리려면 어떻게 설정해야 하나?**"를 구하는 **역산(inverse problem)**입니다.

### 입력

| 파라미터 | 설명 |
|----------|------|
| 출발지 (launch_lat, launch_lng) | 발사 위치 |
| 목적지 (target_lat, target_lng) | 원하는 착지 위치 |
| 탑재물 무게 (payload_mass_g) | 탑재 화물 질량 |
| 발사 시각 (launch_datetime) | 비행 시작 시각 |

### 최적화 알고리즘

서버 측 `planFlight()` 함수가 아래 3가지 전략으로 각각 시뮬레이션을 실행하여 목적지에 가장 가까운 결과를 선택합니다.

**케이스 1 — 표준 구성 (Standard)**
- 풍선: 1000g, 헬륨: 4.0 m³, 낙하산: 1.5 m 십자형
- 상승률 ~5.5 m/s, 버스트 ~33 km

**케이스 2 — 고속 상승 (Fast Ascent)**
- 풍선: 600g, 헬륨: 6.0 m³, 낙하산: 1.2 m 십자형
- 상승률 ~7+ m/s, 낮은 버스트 (~25 km), 빠른 비행으로 수평 드리프트 감소

**케이스 3 — 저속 상승 (Slow Float)**
- 풍선: 1500g, 헬륨: 2.5 m³, 낙하산: 2.0 m 팔각형
- 상승률 ~2 m/s, 높은 버스트 (~36 km), 느린 상승으로 상층 바람을 최대한 활용

각 케이스는 동일한 `runSimulationCore()`를 **결정론적 시드(deterministic seed)**로 실행합니다 (같은 입력 = 같은 결과, 재현성 보장).

### Feasibility 판정

3케이스 중 최소 거리를 기준으로 가능성을 판정합니다:

| 판정 | 조건 | 의미 |
|------|------|------|
| `good` | 최소 거리 ≤ 목적지까지 거리의 30% | 충분히 가능 |
| `marginal` | 최소 거리 ≤ 목적지까지 거리의 60% | 어느 정도 가능 |
| `infeasible` | 최소 거리 > 목적지까지 거리의 60% | 현재 날씨로 불가능 |

### 7일 추천 발사 창 (Recommended Windows)

현재 시각부터 7일 이내의 매 6시간 단위 시각(00:00, 06:00, 12:00, 18:00 UTC)마다 같은 3케이스를 시뮬레이션하여, 목적지에 가장 가까운 시각 상위 5개를 추천합니다.

```
recommended_windows: [
  {
    datetime: "2026-06-11T06:00:00Z",
    label: "내일 오전 6시",
    best_distance_km: 12.4,
    feasibility: "good"
  },
  ...
]
```

### 케이스 활용

**"이 케이스로 시뮬레이션"** 버튼을 클릭하면, 해당 케이스의 파라미터가 시뮬레이션 탭 폼에 자동으로 채워지고 결과도 즉시 표시됩니다. 상세 애니메이션과 차트를 바로 확인할 수 있습니다.

### 출력 (`PlanResult`)

```typescript
{
  cases: FlightCase[],          // 3가지 케이스 결과
  feasible: boolean,
  feasibility_grade: "good" | "marginal" | "infeasible",
  feasibility_reason: string,   // 한국어 설명
  launch_to_target_km: number,  // 직선 거리 (km)
  recommended_windows: RecommendedWindow[],  // 추천 시각 top-5
  wind_data_fetched_at: string
}
```

---

## 6. 기능 3 — 2D / 3D 지도 뷰

파일: `artifacts/balloon-simulator/src/components/Map.tsx`

### 2D 모드 (기본값) — Leaflet

오픈소스 지도 라이브러리 Leaflet + CARTO Dark Matter 타일 사용.

**렌더링 요소:**
- 발사 지점: 초록색 점 마커 + "출발지" 툴팁
- 버스트 지점: 노란색 점 마커
- 착지 지점: 빨간색 점 마커
- 상승 경로: 하늘색 점선 (`#0ea5e9`)
- 하강 경로: 주황색 점선 (`#f97316`)
- 역방향 계획 케이스들: 초록/파랑/주황 색상 구분, 선택된 케이스는 굵게 강조, 나머지는 투명도 적용
- 목적지 마커: 보라색 원형

**자동 뷰포트 조정:**
- 시뮬레이션 완료 시 전체 궤적이 화면 안에 들어오도록 `fitBounds()` 자동 호출
- 역방향 계획 시 출발지 + 목적지 + 모든 케이스 착지점을 포함한 범위로 자동 조정

### 3D 모드 — Three.js (토글)

지도 좌하단 **"3D ▲"** 버튼 클릭 시 활성화. Leaflet이 완전히 언마운트되고 Three.js Canvas가 같은 공간에 마운트됩니다 (WebGL 컨텍스트 충돌 방지).

**좌표 변환 원리:**
```
위도/경도 → OSM Slippy Map 타일 좌표 (zoom=7) → Three.js 월드 좌표
```

타일 좌표 변환:
```
tileX = ((lng + 180) / 360) × 2^z
tileY = (1 - ln(tan(lat_rad) + 1/cos(lat_rad)) / π) / 2 × 2^z
```

Three.js 월드: 씬 원점 = 발사지점 타일 좌표, X=동쪽, Z=남쪽, Y=고도

**고도 스케일 계산:**
```
ALT_SCALE = 8 / 248  (tile-unit per km)
```
한국 위도(37.5°N)에서 zoom-7 타일 1개 = 약 248 km이므로, 8배 과장 시 40 km 최고 고도가 시각적으로 적절한 비율로 표시됩니다.

**CARTO 타일 로딩:**
```typescript
THREE.TextureLoader → CARTO dark_all/{zoom}/{x}/{y}.png
```
9×7 그리드(63개 타일)를 발사 지점 중심으로 로드. Suspense로 각 타일 독립적으로 비동기 로딩합니다.

**3D 요소:**
- 타일 평면: `PlaneGeometry(1, 1)`, `MeshBasicMaterial(texture)`
- 경로 라인: `drei <Line>` 컴포넌트, 고도에 비례한 Y축 값
- 마커 구체: `SphereGeometry`, emissive 재질로 발광 효과
- 수직 드롭라인: 버스트/현재 위치에서 지면까지 반투명 세로선

**카메라:**
- 초기 위치: `(1.5, 6, 8)` — 남동쪽에서 북서쪽을 바라보는 약 55° 부감 시점
- OrbitControls: 드래그 회전, 스크롤 줌, 우클릭 패닝 지원
- `maxPolarAngle = π/2 - 0.02` — 지면 아래로 카메라 이동 제한

---

## 7. 기능 4 — 비행 애니메이션 플레이어

### 위치
시뮬레이션 결과 → "Flight Telemetry" 섹션

### 컨트롤 요소

| UI 요소 | 기능 |
|---------|------|
| ▶/⏸ 버튼 | 재생/일시정지 |
| 슬라이더 | 임의 시점으로 직접 이동 (드래그) |
| 1x / 5x / 10x / 20x | 재생 속도 배율 |
| 퍼센트 표시 | 전체 비행 중 현재 위치 (%) |

### 작동 원리

```typescript
// 재생 인터벌: 100ms / playSpeed
setInterval(() => {
  setAnimFrame(prev => Math.min(prev + 1, trajectory.length - 1));
}, 100 / playSpeed);
```

`animFrame` 상태가 변하면:
1. **지도**: 현재 프레임까지의 경로(진행된 부분)를 진한 하늘색으로, 미래 경로를 반투명 흰색으로 표시. 현재 위치에 발광 마커 표시.
2. **Route3D**: 3D 뷰어에서도 동기화된 위치에 글로잉 구체 표시
3. **텔레메트리 패널**: 현재 프레임의 고도, 풍속, 수직속도, 수평속도, 비행 단계, 기압을 실시간 표시

### 실시간 표시 데이터

```
Alt:     12,450 m          (현재 고도)
Wind:    18.3 m/s          (풍속)
V.Speed: +5.2 m/s          (수직속도, 초록=상승, 빨강=하강)
H.Speed: 18.3 m/s          (수평속도)
Phase:   ASCENT / DESCENT  (비행 단계)
Press:   183.2 hPa         (현재 기압)
```

---

## 8. 기능 5 — 3D 경로 뷰어 (Route3D)

파일: `artifacts/balloon-simulator/src/components/Route3D.tsx`

### 접근 방법
시뮬레이션 결과 → 지도 우상단 **"3D VIEW"** 버튼 클릭 → 전체화면 오버레이 팝업

### Three.js 씬 구성

**좌표 정규화:**
```
// 수평: 최대 편위를 ±4 씬 단위로 정규화
hScale = 4 / max(|Δx|, |Δz|)

// 수직: 최고 고도를 3 씬 단위로 정규화
vScale = 3 / max_altitude_km
```

이 정규화 덕분에 어떤 비행 범위든 항상 시각적으로 적절한 비율로 표시됩니다.

**렌더링 요소:**

| 요소 | 색상 | 설명 |
|------|------|------|
| 상승 경로 라인 | `#0ea5e9` (하늘색) | 상승 구간 3D 선 |
| 하강 경로 라인 | `#f97316` (주황색) | 하강 구간 3D 선 |
| 지면 그림자 선 | `#06b6d4` 반투명 | Y=0에 투영된 수평 궤적 |
| 발사점 구체 | `#10b981` (에메랄드) | LAUNCH 텍스트 라벨 포함 |
| 버스트점 구체 | `#eab308` (노란색) | "BURST 33km" 라벨 포함 |
| 착지점 구체 | `#ef4444` (빨간색) | LANDING 라벨 포함 |
| 버스트 수직선 | 노란색 점선 | 버스트 위치에서 지면까지 |
| 고도 축 | 회색 | 왼쪽에 0/10/20/30/40 km 눈금 |
| 지면 격자 | `#1e3a4a` / `#0e7490` | 2단계 격자 크기 |

**애니메이션 상태일 때:**
- 현재 위치: 두 겹 글로잉 구체 (core `#22d3ee` + 외부 반투명 헤일로)
- 지나온 경로: 진한 하늘색 두꺼운 선
- 미래 경로: 반투명 흰색 얇은 선
- HTML 오버레이: 현재 고도, 풍속, 위도/경도 실시간 표시

**카메라 컨트롤:**
- OrbitControls: 드래그 회전, 스크롤 줌, 우클릭 패닝
- ↺ 리셋 버튼: 초기 카메라 위치로 복귀
- `maxPolarAngle = π/2` — 지면 수평선 아래로 이동 불가

---

## 9. 기능 6 — 실시간 물리 미리보기

### 목적
서버 요청 없이 폼 값이 변할 때마다 즉각적으로 대략적인 상승/하강 속도를 계산하여 사용자에게 피드백 제공.

### 상승 속도 미리보기

```typescript
// 해수면 조건에서 계산 (ISA 기준)
const RHO_AIR_SL = 1.225 kg/m³
const RHO_HE_SL  = 101325 / (2077 × 288.15)  // ≈ 0.1693 kg/m³

r = ∛(3V / 4π)                              // 충진 반지름
net_force = (ρ_air - ρ_He) × V × G - m × G  // 순 부양력
v = √(net_force / (0.5 × C_D × ρ_air × πr²))  // 종단속도
```

### 하강 속도 미리보기

```typescript
v = √(2 × m × G / (C_D × ρ_air × π × (d/2)²))
```

### UI 표시 위치

- 헬륨 부피 입력 옆: `~5.5 m/s 상승` (파란색) / `부력 부족` (빨간색, 0.5 m/s 이하)
- 낙하산 직경 입력 옆: `~3.7 m/s` (주황색)

이 값들은 `useMemo`로 폼 감시(watch) 값이 바뀔 때만 재계산됩니다.

---

## 10. 기능 7 — 비행 텔레메트리 및 차트

### 통계 카드 (4개)

| 카드 | 내용 |
|------|------|
| Flight Time | 총 비행 시간 (h m 형식) |
| Max Altitude | 버스트 고도 (km) |
| Peak Wind | 비행 중 최대 풍속 (m/s) |
| Horiz. Drift | 발사지→착지지 직선 거리 (km) |

### 풍선 설정 계산 패널 (Balloon Configuration)

시뮬레이션 완료 후 자동 계산된 물리값 표시:

| 항목 | 설명 |
|------|------|
| Burst Altitude | 예측 버스트 고도 — 가장 중요한 지표 |
| Ascent Rate | 해수면 기준 상승 속도 |
| Descent (SL) | 해수면 기준 하강 속도 |
| Fill Ø | 지상 충진 직경 (m) |
| Burst Ø | 버스트 시 최대 직경 (m) |
| Fill Vol. | 헬륨 부피 (m³) |
| Neck Lift | 순 부양력 (N) — 줄에 매달 수 있는 탑재물 한계 |

### 비행 차트 (접이식)

**고도 프로파일 (Altitude Profile):**
- X축: 경과 시간 (분)
- Y축: 고도 (m)
- 상승 구간: 하늘색 선
- 하강 구간: 주황색 선
- 버스트 시점: 노란색 수직 기준선

**속도 프로파일 (Speed Profile):**
- X축: 경과 시간 (분)
- Y축: 속도 (m/s)
- 흰색: 합성 속도 (Total Speed)
- 하늘색: 수평 속도 (Horizontal Speed)
- 노란색: 수직 속도 절대값 (|Vertical Speed|)

모든 차트는 Recharts `LineChart`로 구현, `isAnimationActive={false}`로 재렌더링 시 깜빡임 방지.

---

## 11. 기능 8 — 프리셋 시나리오

### 목적
자주 사용하는 설정을 미리 저장해 두어 빠른 시뮬레이션 실행 지원.

### 내장 프리셋 4종

| 프리셋 | 발사지 | 설명 |
|--------|--------|------|
| 한국 표준 기상 탐사 | 서울 | 1000g, 4 m³, 1.5m 십자 → 버스트 ~33 km |
| 초고층 탐사 (38km+) | 부산 | 2000g, 3.5 m³ 소량 헬륨으로 서서히 상승 |
| 고속 상승 단기 미션 | 대전 | 600g, 6 m³ 빠른 상승 → ~26 km |
| 저속 장거리 드리프트 | 강릉 | 1500g, 2 m³ 초저속 → 바람 최대 활용 |

### 작동 원리
`GET /api/presets` → 폼의 `reset()` 호출로 모든 필드를 프리셋 값으로 덮어쓰기. 낙하산 C_D 값으로 낙하산 종류 드롭다운도 자동 매칭.

---

## 12. 기능 9 — 지도 클릭으로 좌표 입력

### 적용 범위
역방향 계획 모드에서 출발지 / 목적지 좌표 입력 시

### 사용 방법
1. "지도에서 선택" 버튼 클릭 (출발지 또는 목적지 중 하나)
2. 지도 커서가 십자(crosshair)로 변경
3. 원하는 위치 클릭
4. 폼의 lat/lng 필드에 소수점 4자리 반올림 좌표 자동 입력
5. 커서 일반 모드 복귀

### 구현

```typescript
// Leaflet 이벤트
useMapEvents({
  click(e) {
    if (clickMode === "launch") {
      planForm.setValue("launch_lat", Math.round(e.latlng.lat * 10000) / 10000);
      planForm.setValue("launch_lng", Math.round(e.latlng.lng * 10000) / 10000);
    }
    setMapClickMode(null);
  }
});

// 3D 모드: 보이지 않는 PlaneGeometry(100, 100)에 onPointerDown
// → Three.js 레이캐스팅으로 클릭 위치 3D 좌표 취득
// → tileFloatToLngLat() 역변환으로 위경도 계산
```

---

## 13. 기능 10 — 탄도 로그 테이블

### 위치
시뮬레이션 결과 → "VIEW FULL TRAJECTORY LOG" 아코디언

### 내용
전체 궤적에서 5스텝마다 샘플링한 데이터:

| 컬럼 | 내용 |
|------|------|
| Time (T+) | 발사 후 경과 분 |
| Alt (m) | 고도 |
| Phase | ASCENT / DESCENT |
| Wind (m/s) | 풍속 |

마지막 포인트(착지)는 항상 포함.

---

## 14. API 엔드포인트 정의

### `GET /api/presets`
내장 프리셋 목록 반환.

**응답:**
```json
[
  {
    "id": "korea-standard",
    "name": "한국 표준 기상 탐사",
    "description": "...",
    "config": { "latitude": 37.5665, ... }
  }
]
```

---

### `POST /api/simulate`
풍선 비행 전방향 시뮬레이션 실행.

**요청 body:**
```json
{
  "latitude": 37.5665,
  "longitude": 126.978,
  "launch_datetime": "2026-06-11T03:00:00Z",
  "balloon_mass_g": 1000,
  "payload_mass_g": 500,
  "helium_volume_m3": 4.0,
  "parachute_diameter_m": 1.5,
  "parachute_cd": 0.97,
  "time_step": 60
}
```

**응답:** `SimulationResult` JSON (약 600~2000개 TrajectoryPoint 포함)

**에러 케이스:**
- `400`: 헬륨 부력 부족 (입력값 오류)
- `502`: Open-Meteo API 통신 실패
- `500`: 시뮬레이션 내부 오류

---

### `POST /api/plan`
역방향 비행 계획 실행.

**요청 body:**
```json
{
  "launch_lat": 37.5665,
  "launch_lng": 126.978,
  "target_lat": 37.0,
  "target_lng": 127.5,
  "payload_mass_g": 500,
  "launch_datetime": "2026-06-11T03:00:00Z"
}
```

**응답:** `PlanResult` JSON (3개 FlightCase + 추천 창 5개 포함)

---

## 15. 데이터 흐름 전체 다이어그램

```
사용자 입력
(폼 파라미터)
      │
      ▼
┌─────────────┐
│  실시간 미리보기 │  ← useMemo + 순수 JS 물리 계산 (서버 없음)
│  상승속도 ~5.5 m/s │
└─────────────┘

      │ (Submit)
      ▼
┌─────────────────────────────────────────┐
│  POST /api/simulate or /api/plan         │
└────────────────────┬────────────────────┘
                     │
                     ▼
           ┌─────────────────┐
           │  Open-Meteo API  │
           │  10기압면 × 7일   │
           │  hourly 바람 데이터│
           └────────┬─────────┘
                    │ windCache
                    ▼
           ┌─────────────────────────┐
           │  runSimulationCore()     │
           │  ┌─────────────────┐    │
           │  │  오일러 적분 루프 │    │
           │  │  for each step:  │    │
           │  │  1. ISA 기압/온도 │    │
           │  │  2. 바람 보간    │    │
           │  │  3. 난류 모델    │    │
           │  │  4. 물리 속도    │    │
           │  │  5. 위치 업데이트│    │
           │  │  6. 버스트/착지 체크│  │
           │  └─────────────────┘    │
           └────────────┬────────────┘
                        │ SimulationResult
                        ▼
           ┌─────────────────────────┐
           │     브라우저 렌더링       │
           │  ┌──────┐  ┌─────────┐  │
           │  │ 지도   │  │  차트   │  │
           │  │ 2D/3D │  │ Alt/Spd│  │
           │  └──────┘  └─────────┘  │
           │  ┌──────┐  ┌─────────┐  │
           │  │ 애니  │  │ Route3D │  │
           │  │ 플레이어│  │ 3D뷰어 │  │
           │  └──────┘  └─────────┘  │
           └─────────────────────────┘
```

---

*이 보고서는 코드베이스를 기반으로 작성되었습니다.*  
*물리 모델 참고: ICAO Doc 7488/3, ISO 2533:1975, Kaymont/Totex 제조사 데이터*
