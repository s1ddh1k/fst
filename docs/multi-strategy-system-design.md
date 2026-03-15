# 멀티 전략 암호화폐 자동매매 시스템 설계문서
버전: v1.0  
대상: Upbit KRW 현물 자동매매 시스템  
작성 목적: **고빈도(1분/5분) + 추세(15분/1시간) 전략을 동시에 운용할 수 있는 실전형 시스템**을 개발하기 위한 구현 설계 기준 문서

---

# 0. 한 줄 결론

지금 필요한 것은 “한 개 전략을 더 고도화하는 것”이 아니라,  
**여러 전략을 동시에 운용하는 멀티 전략 / 멀티 포지션 / 멀티 타임프레임 시스템**으로 아키텍처를 전환하는 것이다.

핵심 구조는 아래와 같다.

```text
시장데이터 수집
  -> 정규화/피처 생성
  -> 전략 레이어(1m / 5m / 15m / 1h)
  -> 포트폴리오/리스크 엔진
  -> 실행 엔진(주문 계획 + 체결 + 재시도 + 취소)
  -> 상태 저장 / 리포트 / 모니터링
```

이 문서는 Codex가 **실제 구현 + 테스트 + 문서화**까지 수행할 수 있도록,
모듈 경계, 인터페이스, 우선 구현 전략, 백테스트/페이퍼/라이브 동등성 원칙을 함께 정의한다.

---

# 1. 목표와 비목표

## 1.1 목표

이 시스템은 다음을 만족해야 한다.

1. **Upbit KRW 현물**에서 동작
2. **롱 전용**
3. **고빈도 전략과 추세 전략을 동시에 운용**
4. **멀티 포지션** 지원
5. **의사결정 타임프레임**과 **실행 타임프레임** 분리
6. **백테스트 / 페이퍼 / 라이브**가 최대한 같은 규칙으로 동작
7. **point-in-time universe** 사용
8. **same-bar fill 금지**
9. 수수료 / 호가단위 / 최소주문금액 / 주문지원유형을 **전략 밖으로 분리**
10. Codex가 단계적으로 구현 가능한 수준으로 **모듈 경계와 수용 기준**을 명확히 정의

## 1.2 비목표

이 문서는 아래를 보장하지 않는다.

- 고수익 보장
- 단일 전략으로 모든 시장 상황 해결
- 초단타 HFT(orderbook micro alpha)를 첫 단계부터 완성
- 업비트 정책 변경과 무관한 영구 고정 규칙

즉, 이 문서의 목적은 **수익을 약속하는 전략 비법**이 아니라,  
**계속 실험하고 살아남는 전략만 승격시킬 수 있는 개발 구조**를 만드는 것이다.

---

# 2. 왜 기존 구조를 버려야 하는가

기존 접근의 핵심 문제는 다음과 같다.

1. **단일 전략**
   - 하나의 전략이 고빈도와 추세를 동시에 해결하려고 했다.
   - 결과적으로 과매매 또는 과희소 거래 사이를 오갔다.

2. **단일 포지션**
   - 동시에 하나의 코인만 들 수 있어, 고빈도/중빈도 기회가 구조적으로 제한되었다.
   - “이 코인을 사야 하는가?”보다 “전체 유니버스 중 무엇을 들고 있을까?” 문제로 변질됐다.

3. **전략과 실행 결합**
   - 수수료, 슬리피지, tick size, min order가 전략에 섞이면 실험 속도와 신뢰성이 모두 떨어진다.

4. **타임프레임 혼동**
   - 실전은 1분/5분을 원하면서, 전략 알파와 체결 미세구조가 섞여 있었다.
   - 의사결정과 집행을 분리해야 한다.

따라서 새 구조는 다음 세 축으로 재설계한다.

- **전략 레이어**: 알파만 판단
- **포트폴리오/리스크 레이어**: 자본, 포지션, 충돌 해결
- **실행 레이어**: 실제 주문 계획과 체결 책임

---

# 3. 설계 원칙

## 3.1 Multi-strategy first
“좋은 전략 하나”보다 **서로 다른 빈도/철학의 전략 묶음**을 전제로 설계한다.

## 3.2 Decision timeframe != execution timeframe
예:
- 추세 회전: 15분 의사결정, 5분 실행
- intraday breakout: 5분 의사결정, 1분 실행
- micro breakout: 1분 의사결정, 1분 실행

## 3.3 Exchange adapter isolation
업비트 특화 로직은 `exchange-upbit`에 몰아 넣고,
전략은 거래소 비의존적 인터페이스 위에서 동작해야 한다.

## 3.4 Research/live parity
백테스트, 페이퍼, 라이브가 가능하면 같은 이벤트 모델과 같은 주문 상태 머신을 사용해야 한다.

## 3.5 Event sourcing friendly
결정과 체결은 모두 이벤트로 남겨야 한다.
이벤트가 남아야 디버깅, 재현, PnL 검증, 규칙 변경 비교가 가능하다.

## 3.6 Promotion by evidence
전략 승격은 “상위 1개 조합이 플러스”가 아니라,
- trade sufficiency
- robustness
- cost after fill
- live shadow consistency
를 통과해야만 가능하다.

---

# 4. 목표 운영 모델

## 4.1 전략군

시스템은 v1에서 다음 3개 전략군을 목표로 한다.

### A. Trend Rotation
- 목적: 큰 추세를 오래 보유
- decision TF: `15m` 또는 `1h`
- execution TF: `5m`
- 보유 시간: 수 시간 ~ 수 일
- 기대 특성: 거래 적음, 개별 trade의 기대 이익 폭 큼

### B. Breakout Rotation
- 목적: intraday 강세 자산의 돌파 구간 포착
- decision TF: `5m` 또는 `15m`
- execution TF: `1m`
- 보유 시간: 수십 분 ~ 수 시간
- 기대 특성: 거래 중간, 추세와 고빈도 사이 연결 역할

### C. Micro Strategy
- 목적: 1분 단위의 짧은 모멘텀/미세 돌파/짧은 mean reversion
- decision TF: `1m`
- execution TF: `1m`
- 보유 시간: 수 분 ~ 수십 분
- 기대 특성: 거래 많음, edge 작음, execution 품질 영향 큼

## 4.2 포지션 구조

v1 기본값:

- `maxOpenPositions = 5`
- `maxPositionPerMarket = 1`
- `maxCapitalUsage = 95%`
- 전략군별 자본 상한
  - Trend: 40%
  - Breakout: 35%
  - Micro: 20%
  - Reserve cash: 5%

### 규칙
- 같은 시장(`KRW-BTC`)에 대해 중복 포지션 금지
- 서로 다른 전략이 같은 시장을 원하면 **포트폴리오 엔진이 하나의 최종 포지션만 결정**
- 동일 마켓 충돌 시 기본 우선순위:
  1. 이미 보유 중인 포지션 유지 판단
  2. 손실 방지/리스크 감소 명령 우선
  3. 동일 마켓 신규 진입은 더 높은 `portfolioScore`만 채택

---

# 5. 상위 아키텍처

```text
┌────────────────────────────────────────────────────────────────┐
│                     Strategy Research / Live Core             │
├────────────────────────────────────────────────────────────────┤
│ Market Data Layer                                             │
│  - REST candle backfill                                       │
│  - WebSocket trade / ticker / orderbook / myOrder            │
│  - Full-grid bar normalization                                │
│  - Point-in-time universe snapshots                           │
├────────────────────────────────────────────────────────────────┤
│ Feature Layer                                                 │
│  - OHLCV features                                              │
│  - relative strength / volume / volatility / breadth          │
│  - regime features                                             │
│  - execution features (spread, depth, short-term imbalance)   │
├────────────────────────────────────────────────────────────────┤
│ Strategy Layer                                                │
│  - TrendRotationStrategy                                      │
│  - BreakoutRotationStrategy                                   │
│  - MicroBreakoutStrategy                                      │
│  - later: MicroMeanReversion / OrderbookImbalance             │
├────────────────────────────────────────────────────────────────┤
│ Portfolio + Risk Layer                                        │
│  - strategy sleeve allocation                                 │
│  - conflict resolution                                        │
│  - max positions / per-market cap / cooldown                  │
│  - kill switch / drawdown guard / regime disable              │
├────────────────────────────────────────────────────────────────┤
│ Execution Layer                                               │
│  - order intent planner                                       │
│  - execution router                                           │
│  - simulator / paper / live adapters                          │
│  - child order logic                                          │
│  - cancel/replace / timeout / slippage                        │
├────────────────────────────────────────────────────────────────┤
│ State + Reporting Layer                                       │
│  - event store                                                │
│  - fills / positions / pnl ledger                             │
│  - strategy/funnel/ghost reports                              │
│  - dashboards / alerts                                        │
└────────────────────────────────────────────────────────────────┘
```

---

# 6. 저장소 구조 제안

```text
apps/
  backtester/
  paper-trader/
  live-trader/
  report-cli/

packages/
  core-types/
  market-data/
  feature-store/
  strategy-sdk/
  strategies-trend/
  strategies-intraday/
  strategies-micro/
  portfolio-engine/
  risk-engine/
  execution-engine/
  exchange-upbit/
  ledger/
  reporting/
  utils/
```

### 각 패키지 책임

- `core-types`: 공통 타입, enum, IDs, domain object
- `market-data`: 캔들/체결/호가 수집, 정규화, PTI 유니버스 생성
- `feature-store`: 피처 계산 및 캐시
- `strategy-sdk`: 전략 인터페이스와 헬퍼
- `strategies-*`: 실제 전략 구현
- `portfolio-engine`: 포지션 선택, 전략 충돌 해결, 자본 할당
- `risk-engine`: 손실 제한, 회로차단, 노출 한도
- `execution-engine`: 주문 계획, 시뮬레이터, paper/live 공용 상태머신
- `exchange-upbit`: REST/WebSocket 어댑터
- `ledger`: 주문/체결/포지션/PnL 원장
- `reporting`: walk-forward, ghost, funnel, live reconciliation 리포트

---

# 7. 데이터 계층 설계

## 7.1 데이터 소스

필수 데이터:

1. 분 캔들 (1m, 5m, 15m, 1h)
2. 현재가/체결
3. 호가(orderbook)
4. 내 주문/체결(myOrder)
5. 계정/주문 가능 정보


### 현재 Upbit 공식 문서 기준으로 구현 시 반영할 사실
- 분 캔들은 `1, 3, 5, 10, 15, 30, 60, 240` 분 단위를 지원하며, **해당 시간대에 체결이 없으면 캔들이 생성되지 않는다.**
- 주문 생성은 지정가(`limit`), 시장가(`price`/`market`), 최유리 지정가(`best`)를 지원하며,
  `time_in_force`로 `ioc`, `fok`, `post_only`를 일부 조합에서 지원한다.
- `orders/chance`는 종목별 적용 수수료, maker 수수료, 지원 주문 유형, 최소/최대 주문 가능 금액, 잔고를 반환하므로
  실행 엔진은 이를 사용해 주문 가능 여부를 검증해야 한다.
- `myOrder` WebSocket은 실제 주문 또는 체결이 발생할 때만 스트림이 전송되므로,
  수신이 없다고 해서 연결 오류로 단정하면 안 된다.
- KRW 마켓 호가 정책은 변경 이력이 있으므로, 주문 가격 단위는 하드코딩보다 정책 캐시/조회로 다루는 편이 안전하다.

## 7.2 핵심 주의점

업비트 분 캔들은 **해당 시간대에 체결이 있었을 때만 생성**되므로,
무거래 구간을 그대로 비워 두면 종목별 lookback 길이와 시간 간격이 달라진다.
따라서 모든 연구/백테스트/실행 전 피처 계산은 **full time grid 재인덱싱**을 전제로 한다.

### full-grid 규칙
- `close`: 직전 종가 carry-forward
- `open/high/low`: 필요 시 직전 종가 또는 규칙 기반 보정
- `volume`, `quoteVolume`, `tradeCount`: 0
- `isSyntheticBar: true`

### synthetic bar 규칙
- 진입 신호에는 기본적으로 synthetic bar를 사용하지 않는다.
- 보유 중 추적(stop/trail) 계산에는 사용 가능하다.

## 7.3 point-in-time universe

유니버스는 “현재 기준 상위 코인”이 아니라 매 시점의 과거 정보만으로 만들어야 한다.

### v1 기본안
- 기준: rolling quote volume
- 계산 윈도우: 7일 또는 30일
- 재구성 주기: 15분 또는 1시간
- 결과: `UniverseSnapshot(timestamp, markets[])`

### 권장
- research 단계에서는 `top 20~30`
- 실거래 후보는 `top 10~15`
- discovery와 deployment 유니버스를 분리

## 7.4 저장 모델

```typescript
type CanonicalBar = {
  market: string;
  timeframe: "1m" | "5m" | "15m" | "1h";
  tsOpen: number;
  tsClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeBase: number;
  volumeQuote: number;
  tradeCount: number;
  isSyntheticBar: boolean;
};

type UniverseSnapshot = {
  ts: number;
  rankingWindow: "7d" | "30d";
  timeframe: "15m" | "1h";
  markets: string[];
  ranks: Array<{
    market: string;
    quoteVolume: number;
    rank: number;
  }>;
};
```

---

# 8. 피처 계층 설계

## 8.1 공통 피처
- EMA, SMA, ATR, RSI, Donchian
- volatility percentile
- rolling return
- rolling quote volume
- volume spike
- breadth
- trend score
- market composite return
- market composite volume
- relative strength percentile
- liquidity score
- spread estimate

## 8.2 타임프레임별 피처 사용 원칙

### 15m/1h 전략
- 추세, breadth, relative strength, ATR 중심
- 미세 호가 피처는 직접 사용하지 않음

### 5m 전략
- breakout, intraday momentum, short-term volume confirmation
- spread/quote volume을 execution suitability 피처로 사용

### 1m 전략
- 아주 짧은 모멘텀, micro pullback, open-range breakout
- 가능하면 체결/호가 기반 execution-aware 피처 추가
- 순수 candle-only 1m 전략은 v1에서 가능하지만,
  진짜 HFT 수준(orderbook imbalance)은 raw orderbook replay가 준비된 뒤 진행

## 8.3 피처 계산 원칙
- 모든 피처는 `bar close` 기준으로 계산
- 미래 데이터 사용 금지
- 종목간 비교가 필요한 피처는 동일 시점 PTI 유니버스 기준으로 계산
- 피처 캐시와 원시 데이터는 버전 식별자를 가진다

---

# 9. 전략 인터페이스 설계

기존 `ScoredStrategy`는 유지할 수 있지만, 멀티 전략 시스템에는 더 넓은 인터페이스가 필요하다.

## 9.1 v1 인터페이스

```typescript
type StrategyTimeframe = "1m" | "5m" | "15m" | "1h";

type ExecutionPlanHint = {
  executionTimeframe: "1m" | "5m";
  style: "market" | "best_ioc" | "limit_passive" | "limit_aggressive";
  maxSlipBps: number;
  ttlSec?: number;
  retryBudget?: number;
};

type StrategySignal = {
  strategyId: string;
  market: string;
  decisionTs: number;
  signal: "ENTER_LONG" | "EXIT_LONG" | "REDUCE" | "HOLD";
  conviction: number;        // 0~1
  targetRiskPct?: number;    // sleeve 예산 내 목표 위험 비중
  targetNotionalPct?: number;
  executionHint: ExecutionPlanHint;
  metadata?: Record<string, unknown>;
};

type StrategyContext = {
  market: string;
  decisionTimeframe: StrategyTimeframe;
  executionTimeframe: StrategyTimeframe;
  index: number;
  bars: CanonicalBar[];
  universeSnapshot?: UniverseSnapshot;
  marketState?: MarketState;
  existingPosition?: PositionView;
  accountState?: AccountView;
  featureView: FeatureView;
};

interface Strategy {
  readonly id: string;
  readonly family: "trend" | "breakout" | "micro" | "meanreversion";
  readonly decisionTimeframe: StrategyTimeframe;
  readonly executionTimeframe: StrategyTimeframe;
  readonly parameterSpec: ParameterSpec[];

  generateSignal(ctx: StrategyContext): StrategySignal;
}
```

## 9.2 하위 호환
기존 `ScoredStrategy`는 `StrategyAdapter`로 감싸서 새 인터페이스에 연결한다.
단, 새 시스템의 기준 인터페이스는 `StrategySignal`이다.

---

# 10. 우선 구현할 전략 설계

## 10.1 Strategy A: Relative Strength Rotation (권장 1순위)

### 목적
단일 rare setup을 기다리는 대신,
**상대적으로 가장 강한 자산을 정기적으로 보유**하는 구조로 trade sufficiency를 회복한다.

### 의사결정 TF
- 기본: `15m`
- 대안: `1h`

### 실행 TF
- `5m`

### 논리
1. 시장 레짐이 위험 회피가 아니면 활성
2. 유니버스 상위 종목 중 `strengthScore` 계산
3. 현재 보유보다 충분히 강한 종목이 있으면 교체
4. 레짐 악화 시 현금화

### 추천 exposed params (4개)
- `rebalanceBars`
- `entryFloor`
- `exitFloor`
- `switchGap`

### strengthScore 예시
```text
0.45 * momentumPercentile
+ 0.35 * returnPercentile
+ 0.20 * compositeMomentumSpreadScore
```

### 진입/교체
- flat & best.score >= entryFloor -> 진입
- holding & best.market != current.market & best.score - current.score >= switchGap -> 교체

### 청산
- `trendScore < 0`
- 또는 `current.score < exitFloor`
- 또는 ATR 기반 보호 청산

## 10.2 Strategy B: Breakout Rotation (권장 2순위)

### 목적
강한 종목의 intraday breakout을 5분 기준으로 포착하고 1분 실행으로 비용을 낮춘다.

### decision TF
- `5m`

### execution TF
- `1m`

### 추천 exposed params (4개)
- `breakoutLookback`
- `strengthFloor`
- `maxExtensionAtr`
- `trailAtrMult`

### 진입 개념
- 시장 레짐 양호
- 종목 strength 상위권
- `close > highestHigh(lookback)`
- 단, `close - EMA20 <= maxExtensionAtr * ATR`
- 너무 멀리 달아난 breakout은 제외

### 청산
- failed breakout
- ATR trailing stop
- risk-off
- rank decay

## 10.3 Strategy C: Micro Breakout / Micro Reversion (권장 3순위)

### 목적
1분 봉에서 짧은 holding time을 가진 전략을 운용

### 주의
이 전략은 candle-only로도 시작할 수 있지만,
진짜 고빈도 품질을 얻으려면 이후 orderbook/trade raw event 저장이 필요하다.

### v1 추천 exposed params (4개)
- `lookbackBars`
- `extensionThreshold`
- `holdingBarsMax`
- `stopAtrMult`

### 진입 후보
- 짧은 range contraction 후 고점 돌파
- 또는 1분 short pullback 후 재돌파

### 청산
- 3~10 bars 내 follow-through 실패
- 짧은 ATR stop
- time stop

---

# 11. 포트폴리오 엔진 설계

## 11.1 책임
- 전략군별 signal 수집
- sleeve 자본 배정
- 동일 마켓 충돌 해결
- 최대 포지션 수 통제
- 포지션 크기 결정
- re-entry cooldown
- live kill switch 연동

## 11.2 핵심 타입

```typescript
type SleeveId = "trend" | "breakout" | "micro";

type StrategySleeveConfig = {
  sleeveId: SleeveId;
  capitalBudgetPct: number;
  maxOpenPositions: number;
  maxSinglePositionPct: number;
  priority: number;
};

type PositionKey = {
  market: string;
};

type PositionIntent = {
  strategyId: string;
  sleeveId: SleeveId;
  market: string;
  action: "OPEN" | "CLOSE" | "REDUCE" | "KEEP";
  targetNotional: number;
  conviction: number;
  reason: string;
  executionHint: ExecutionPlanHint;
};

type PortfolioDecision = {
  ts: number;
  intents: PositionIntent[];
  blockedSignals: Array<{
    strategyId: string;
    market: string;
    reason: string;
  }>;
};
```

## 11.3 충돌 규칙

### 케이스 A: 같은 마켓에 여러 전략이 신규 진입
- 이미 포지션 없으면 `portfolioScore`가 가장 높은 하나만 채택
- 나머지는 blocked 기록

### 케이스 B: 이미 해당 마켓 보유 중
- 같은 방향 강화 신호는 포지션 증가 대신 confidence 기록만 할 수 있음
- 반대 방향 청산 신호는 **리스크 감축**이 우선

### 케이스 C: 전역 최대 포지션 초과
- 신규 진입 후보를 `portfolioScore` 순으로 정렬
- 상위만 채택

## 11.4 portfolioScore 예시
```text
0.60 * conviction
+ 0.15 * strategyPriorityScore
+ 0.15 * liquiditySuitability
- 0.10 * costPenalty
```

## 11.5 position sizing

### 기본 규칙
- 전략이 직접 수량을 결정하지 않는다.
- 전략은 `targetRiskPct` 또는 `targetNotionalPct`만 제안한다.
- 최종 수량은 PortfolioEngine + RiskEngine + ExchangeAdapter가 계산한다.

### v1 sizing
- `riskBudgetPerTrade = sleeveCapital * riskPct`
- `qty = floor_to_tick( riskBudget / stopDistance )`
- 최소 주문 금액/수량 미달 시 skip

---

# 12. 리스크 엔진 설계

## 12.1 계층별 리스크

### 전략 레벨
- 개별 전략 손절
- time stop
- follow-through failure
- stale position exit

### sleeve 레벨
- 동시 포지션 수
- 하루 손실 한도
- 연속 손실 쿨다운
- regime disable

### 계정 레벨
- 총 자본 사용 상한
- 일중 최대 손실
- 최대 허용 미체결 주문 수
- 전체 kill switch

## 12.2 추천 kill switch
- 일중 손실률 한도 초과
- API 주문 실패율 급증
- 계정/원장 불일치
- WebSocket 단절 후 재동기화 실패
- 시장 상태 비정상 (호가/체결 데이터 공백)

---

# 13. 실행 엔진 설계

## 13.1 책임
- 포트폴리오 의도를 실제 주문 계획으로 변환
- 주문 상태 추적
- 부분 체결/취소/재호가
- 시뮬레이터/페이퍼/라이브 공용 주문 상태 머신 제공

## 13.2 주문 스타일

v1 지원:

- `market`
- `best_ioc`
- `limit_passive`
- `limit_aggressive`

### 추천 정책
- Trend: `best_ioc` 또는 `limit_aggressive`
- Breakout: `best_ioc`
- Micro: `limit_aggressive` 또는 매우 짧은 `best_ioc`


### 현재 지원 주문 방식 기준 권장 매핑
- `market` 스타일은 즉시 체결이 필요하지만 슬리피지 허용 폭이 큰 경우에만 사용
- `best_ioc`는 빠른 체결과 과도한 가격 추격 사이의 절충안으로 우선 사용
- `limit_passive`는 메이커 체결을 노리는 저빈도/여유 있는 진입에 사용
- `limit_aggressive`는 직전 최우선 호가 근처로 짧게 재호가하는 방식으로 구현

## 13.3 OrderIntent -> OrderPlan

```typescript
type OrderIntent = {
  market: string;
  side: "BUY" | "SELL";
  notional?: number;
  quantity?: number;
  style: "market" | "best_ioc" | "limit_passive" | "limit_aggressive";
  maxSlipBps: number;
  ttlSec?: number;
  reason: string;
  sourceStrategyId: string;
};

type ChildOrderPlan = {
  orderType: "market" | "best" | "limit";
  timeInForce?: "ioc" | "fok" | "post_only";
  price?: number;
  quantity?: number;
  notional?: number;
};

type OrderPlan = {
  intent: OrderIntent;
  childOrders: ChildOrderPlan[];
};
```

## 13.4 same-bar fill 규칙
- bar close에서 signal 생성
- 해당 signal로 생성된 주문은 **동일 bar 체결 금지**
- 최소 다음 execution bar부터 fill 가능

예:
- 15m decision 전략이 10:15 close에 진입 시그널 생성
- 실제 fill은 10:16 이후의 1m/5m 실행 바에서만 가능

## 13.5 fill model 레벨

### Level 1: next-bar fill quote
- 다음 실행 바의 open 또는 best quote 기반 체결
- 빠른 연구용

### Level 2: spread-aware bar fill
- bar high/low/open/close와 spread 추정, maxSlip, timeout 반영
- v1 권장

### Level 3: orderbook replay fill
- orderbook/trade raw stream 기반
- 진짜 1분 이하 미세전략/HFT 전용
- v2 이상

---

# 14. Exchange Adapter (Upbit) 설계

## 14.1 책임
- 인증
- 주문 생성/취소/조회
- 주문 가능 정보 조회
- 계정 자산 조회
- 시세 REST 호출
- WebSocket 연결/재연결/구독
- 호가단위 및 최소주문 제약 반영

## 14.2 구현 원칙
- 전략은 주문 가능 수수료, tick size, min total을 직접 알지 않는다.
- 실행 전 `orders/chance` 또는 정책 캐시를 통해 검증한다.
- KRW 호가 단위 정책 변경 가능성을 전제로, **상수 하드코딩 최소화**.

## 14.3 추천 모듈
```text
exchange-upbit/
  auth/
  rest-client/
  websocket-client/
  market-policy-cache/
  order-translator/
  balance-sync/
  order-sync/
```

## 14.4 실시간 스트림
- public:
  - ticker
  - trade
  - orderbook
  - candle (선택)
- private:
  - myOrder
  - myAsset

## 14.5 재동기화
- WebSocket disconnect 후:
  1. open orders 재조회
  2. balances 재조회
  3. 미확정 local order state reconcile
  4. 이후 재구독

---

# 15. 백테스트 엔진 설계

## 15.1 핵심 목표
- “전략이 맞는지”와 “실행이 맞는지”를 분리
- 바 기반 연구와 실제 체결 논리를 최대한 같은 주문 상태 머신에서 재현

## 15.2 필수 출력
- pnl summary
- trade list
- signal count
- blocked signal count
- executed trade count
- turnover
- fees
- estimated slippage
- stage funnel report
- ghost study report
- raw ghost event log
- fold summary

## 15.3 ghost study
각 전략 신호가 실제 포지션이 되지 않았더라도,
신호 후 6/12/24 bar의 MFE/MAE/gross/net을 기록한다.

목적:
- entry edge와 exit 문제 분리
- coordinator 병목 여부 확인
- signal quality 측정

## 15.4 stage funnel
전략마다 아래 단계 수를 남긴다.

- universe eligible
- regime pass
- setup pass
- trigger pass
- portfolio accepted
- execution fill
- completed trade

funnel이 있어야 “거래가 적다”를 더 세밀하게 진단할 수 있다.

## 15.5 walk-forward
기본 v1:
- train 90d
- holdout 30d
- step 14d
- strategy family별 동일 규칙 비교

### 추가 기준
- executedTradeCount
- avgTestReturn
- medianTestReturn
- bootstrapPassRate
- randomPassRate
- top-trade dependence
- trade sufficiency

---

# 16. 페이퍼 트레이딩 / 라이브 설계

## 16.1 paper trading
paper는 “가짜 체결”이 아니라 **실제 주문 경로와 같은 상태 머신을 쓰되, 거래소 호출만 mock** 해야 한다.

즉 다음은 라이브와 동일해야 한다.
- 전략 생성 시점
- 포트폴리오 의사결정
- 주문 계획
- 타임아웃
- 취소/재호가
- 원장 기록

## 16.2 live trading
라이브에서는 다음이 필요하다.
- 주문 identifier 정책
- 재시도 정책
- 계정/원장 reconcile
- kill switch
- alerting
- state persistence
- 재기동 후 복구

## 16.3 shadow mode
정식 라이브 전에:
- paper engine이 live market data를 구독
- 가상 주문 결과와 실제 체결 가능성을 비교
- decision latency / expected fill / missed fill 분석

---

# 17. 관측성(Observability) 설계

필수 대시보드:

1. 전략별 실시간 signal 수
2. 전략별 accepted / blocked 비율
3. 체결률 / 취소율 / 평균 슬리피지
4. sleeve별 PnL, MDD, exposure
5. market별 open position
6. WebSocket 연결 상태
7. REST 오류율 / 주문 오류율
8. 데이터 공백 / synthetic bar 비율
9. reconcile mismatch count

필수 알림:
- 주문 실패 연속 N회
- 잔고 mismatch
- 실시간 데이터 공백
- 일중 손실 한도 도달
- 미체결 주문 장시간 잔류

---

# 18. 성과 승격 기준

## 18.1 연구 승격 기준
전략 후보는 아래를 동시에 만족해야 한다.

- `executedTradeCount >= 25`
- `avgTestReturn > 0`
- `medianTestReturn > 0`
- `bootstrapPassRate >= 0.60`
- `randomPassRate >= 0.60`
- 상위 몇 개 trade가 전체 수익 대부분을 독점하지 않을 것
- 이웃 파라미터 조합도 비슷한 결과일 것

## 18.2 paper -> live 승격 기준
- live shadow / paper fill 차이 허용 범위 내
- 주문 실패율/슬리피지 안정
- 리스크/kill switch 정상 동작
- 최소 2~4주 shadow 관찰

---

# 19. 단계별 구현 순서 (Codex 실행 플랜)

## Phase 0. 기반 정리
- 기존 단일 전략/단일 포지션 가정 코드에서 공통 타입 추출
- `exchange-upbit`, `execution-engine`, `portfolio-engine`, `strategy-sdk` 경계 정리
- full-grid bar normalization 추가
- PTI universe snapshot 도입
- raw event store 도입

## Phase 1. 멀티 포지션 + sleeve 포트폴리오
- `maxOpenPositions > 1`
- sleeve budget
- 같은 마켓 중복 금지
- conflict resolution
- blocked signal logging

## Phase 2. Relative Strength Rotation 구현
- 15m decision / 5m execution
- backtest + paper 연결
- funnel/ghost/log 추가

## Phase 3. Breakout Rotation 구현
- 5m decision / 1m execution
- same-bar 금지 유지
- spread-aware fill 적용

## Phase 4. Micro Strategy 구현
- 1m candle-based micro breakout/reversion
- time stop / fast failure exit
- intraday capacity metrics 추가

## Phase 5. Upbit live adapter 강화
- order chance 기반 정책 캐시
- myOrder/myAsset reconciliation
- reconnect recovery
- rate-limit aware queue

## Phase 6. Orderbook-aware research
- raw orderbook/trade capture
- replay engine
- HFT 전용 피처/전략 추가

---

# 20. 수용 기준(Definition of Done)

각 Phase는 아래를 만족해야 완료로 본다.

## 공통
- 타입체크 통과
- 테스트 통과
- 문서 업데이트
- 리포트 재생성 가능

## 포트폴리오 엔진
- 멀티 포지션 유지 가능
- 같은 마켓 중복 진입 방지
- blocked reason 로그 확인 가능

## 실행 엔진
- same-bar fill 금지
- cancel/replace/timeout 재현 가능
- live/paper/backtest 공용 상태 머신 사용

## 전략
- parameter grid 실행 가능
- walk-forward 리포트 생성 가능
- ghost + funnel 출력 가능

## 라이브
- 재시작 복구 가능
- open orders / balances reconcile 가능
- kill switch 수동/자동 동작

---

# 21. Codex가 바로 구현해야 할 인터페이스 목록

## 21.1 핵심 파일 후보
```text
packages/core-types/src/
  domain.ts
  strategy.ts
  execution.ts
  portfolio.ts

packages/market-data/src/
  canonical-bar.ts
  universe-snapshot.ts
  full-grid-normalizer.ts

packages/strategy-sdk/src/
  Strategy.ts
  adapters/ScoredStrategyAdapter.ts

packages/portfolio-engine/src/
  PortfolioEngine.ts
  SleeveAllocator.ts
  ConflictResolver.ts

packages/risk-engine/src/
  RiskEngine.ts
  KillSwitch.ts

packages/execution-engine/src/
  ExecutionRouter.ts
  OrderPlanner.ts
  OrderStateMachine.ts
  ExecutionSimulator.ts

packages/exchange-upbit/src/
  UpbitRestClient.ts
  UpbitWebSocketClient.ts
  MarketPolicyCache.ts
  OrderChanceService.ts
  BalanceReconciler.ts
```

## 21.2 테스트 우선순위
1. full-grid normalization
2. PTI universe snapshot correctness
3. same-bar fill ban
4. duplicate market blocking
5. sleeve capital budgeting
6. order cancel/replace
7. reconnect reconciliation
8. ghost/funnel metrics generation

---

# 22. Codex 구현 시 주의사항

1. **1시간 전략만 강제하지 말 것**
   - 시스템은 1m/5m/15m/1h를 모두 지원해야 한다.

2. **전략에서 거래소 제약을 직접 다루지 말 것**
   - tick size, min order, fee, supported order type은 adapter/execution 책임이다.

3. **멀티 전략 충돌 해결을 임시 if문으로 때우지 말 것**
   - 명시적인 `ConflictResolver`를 둘 것.

4. **백테스트와 라이브의 주문 상태 머신을 다르게 만들지 말 것**
   - 모드는 달라도 상태 전이는 같아야 한다.

5. **진짜 HFT 전략은 candle-only에서 과신하지 말 것**
   - orderbook/trade replay 없이는 microstructure edge 검증이 불완전하다.

6. **로그를 먼저 남길 것**
   - signal, blocked, intent, plan, fill, cancel, reconcile 모두 이벤트로 남겨야 한다.

---

# 23. 개발 시작 기본값 추천

## 시스템 기본값
- `maxOpenPositions = 5`
- `maxPositionPerMarket = 1`
- `reserveCashPct = 0.05`

## sleeve 기본값
- trend: 40%
- breakout: 35%
- micro: 20%

## 전략 우선순위
1. Relative Strength Rotation
2. Breakout Rotation
3. Micro Breakout/Reversion
4. 이후 orderbook imbalance

## 연구 우선순위
1. trade sufficiency 회복
2. ghost net positive 확인
3. fill quality 검증
4. robustness
5. live shadow consistency

---

# 24. 공식 참고 문서(검증용)

구현 시 아래 공식 문서를 기준으로 재검증한다.  
정책은 바뀔 수 있으므로 하드코딩보다 adapter 캐시/조회 구조를 우선한다.

- Upbit 주문 생성 API
- Upbit 주문 가능 정보(chance) API
- Upbit 분 캔들 API
- Upbit KRW 마켓 호가 정책 / 최소 주문 금액
- Upbit WebSocket Orderbook
- Upbit WebSocket MyOrder
- Upbit REST/WebSocket Best Practice

문서 URL은 구현 시 최신 공식 문서로 다시 확인한다.


### 실제 문서 URL
- 분 캔들 API: https://docs.upbit.com/kr/reference/list-candles-minutes
- 주문 생성 API: https://docs.upbit.com/kr/reference/new-order
- 주문 가능 정보(chance) API: https://docs.upbit.com/kr/reference/available-order-information
- KRW 마켓 호가 정책 / 최소 주문 금액: https://docs.upbit.com/kr/docs/krw-market-info.md
- WebSocket Orderbook: https://docs.upbit.com/kr/reference/websocket-orderbook
- WebSocket MyOrder: https://docs.upbit.com/kr/reference/websocket-myorder
- REST API Best Practice: https://docs.upbit.com/kr/docs/rest-api-best-practice.md
- WebSocket Best Practice: https://docs.upbit.com/kr/docs/websocket-best-practice.md

---

# 25. 최종 결론

당신이 원하는 시스템은 “1시간봉 전략 하나”가 아니라 아래 시스템이다.

- **15분/1시간**에서 큰 방향을 잡는 추세 전략
- **5분/15분**에서 intraday 기회를 잡는 breakout 전략
- **1분**에서 빠른 기회를 잡는 micro 전략
- 이를 동시에 돌릴 수 있는 **멀티 포지션 / 멀티 sleeve 포트폴리오**
- 거래소 제약을 분리한 **실행 엔진**
- 백테스트/페이퍼/라이브가 최대한 같은 규칙으로 움직이는 **공통 상태 머신**

즉, 다음 개발 목표는 “전략 하나를 고치기”가 아니라  
**전략을 계속 추가하고 탈락시키고 승격시킬 수 있는 자동매매 운영체제(trading operating system)를 만드는 것**이다.
