# Portfolio Coordinator + Execution Simulator 상세 설계안

이 문서는 `AGENTS.md`의 구현 지시를 구체화한 기술 설계 문서다.
Codex는 이 문서를 기준으로 **실제 구현 코드 + 테스트**를 작성해야 한다.

---

# 1. 목표

현재 시스템은 전략이 종목별로 독립 신호를 내고, 실제 제약은 단일 포지션이라서 구조적 충돌이 있다.
이를 해결하기 위해 다음 두 모듈을 새로 만든다.

1. **PortfolioCoordinator**
   - 유니버스 전체 신호를 취합하고,
   - 언제 어떤 종목을 살지/팔지/아무것도 하지 않을지 결정한다.

2. **ExecutionSimulator**
   - 코디네이터가 낸 거래 의도를 실제 백테스트 체결로 변환한다.
   - 수수료, slippage, tick size, 최소 주문 금액, same-bar 금지 규칙을 담당한다.

핵심 원칙은 다음이다.

- 전략은 알파만 제공한다.
- 포트폴리오 레이어는 "무엇을 들고 있을지" 결정한다.
- 실행 레이어는 "어떻게 체결되었는지" 결정한다.

---

# 2. 설계 철학

## 2.1 단일 포지션을 1급 제약으로 취급
이 시스템은 동시에 1개 종목만 들 수 있다.
따라서 전략 결과를 단순히 종목별로 독립 실행하면 안 된다.
반드시 한 시점에 **유니버스 전체 BUY 후보 중 하나만 선택**해야 한다.

## 2.2 신호와 체결을 분리
전략은 `BUY/SELL/HOLD`와 `conviction`만 내고,
실제 체결 가격/수량/수수료/미체결 여부는 simulator가 결정해야 한다.

## 2.3 same-bar optimistic bias 제거
`t` 시점 바가 닫혀서 신호가 생성되면,
그 신호는 **최소한 `t+1` 바에서만 체결 가능**해야 한다.

## 2.4 v1은 bar-based, v2는 order-book ready
처음에는 next-bar bar-based fill model로 구현해도 된다.
다만 인터페이스는 추후 order-book replay 또는 best bid/ask 기반 fill model을 끼워 넣을 수 있게 설계한다.

---

# 3. PortfolioCoordinator 설계

## 3.1 책임

PortfolioCoordinator는 다음 책임을 가진다.

- 같은 시점의 유니버스 전체 전략 결과를 취합한다.
- 신규 진입 가능한 BUY 후보를 필터링한다.
- BUY 후보를 랭킹해서 하나만 선택한다.
- 보유 포지션이 있으면 해당 종목의 SELL/HOLD만 우선 처리한다.
- cooldown, re-entry guard, optional turnover guard를 적용한다.
- 체결 모듈로 넘길 order intent를 생성한다.

---

## 3.2 비책임

아래는 PortfolioCoordinator의 책임이 아니다.

- 기술적 지표 계산
- 전략 신호 계산 로직 자체
- 실제 fill price 계산
- 수수료 및 slippage 계산
- 최소 주문 금액 검증
- tick size rounding

이런 것들은 strategy 또는 execution simulator의 책임이다.

---

## 3.3 제안 인터페이스

```typescript
type CandidateSignal = {
  market: string;
  timestamp: number;
  signal: "BUY" | "SELL" | "HOLD";
  conviction: number;
  lastPrice: number;
  marketState?: MarketStateContext;
  metadata?: {
    estimatedSpreadBps?: number;
    liquidityScore?: number;
    isSyntheticBar?: boolean;
  };
};

type OpenPosition = {
  market: string;
  entryTimestamp: number;
  entryPrice: number;
  quantity: number;
  barsHeld: number;
  highestPriceSinceEntry?: number;
  lowestPriceSinceEntry?: number;
};

type PortfolioState = {
  cash: number;
  position?: OpenPosition;
  cooldownUntilByMarket: Record<string, number>;
  lastExitReasonByMarket: Record<string, string | undefined>;
  tradesToday: number;
  lastTradeTimestamp?: number;
};

type CoordinatorConfig = {
  minBuyConviction: number;
  cooldownBarsAfterLoss: number;
  minBarsBetweenReentry: number;
  maxTradesPerDay?: number;
  allowSwitching?: boolean; // v1 기본 false
  ignoreSyntheticBarsForEntry?: boolean; // 기본 true
};

type OrderIntent = {
  side: "BUY" | "SELL";
  market: string;
  timestamp: number;
  orderStyle: "market" | "best_ioc" | "limit";
  reason:
    | "entry"
    | "signal_exit"
    | "stop_exit"
    | "trail_exit"
    | "risk_off_exit"
    | "rebalance_exit";
  conviction: number;
  targetNotional?: number;
  targetQuantity?: number;
  limitPrice?: number;
  metadata?: Record<string, unknown>;
};
```

---

## 3.4 동작 규칙

### Case A. 보유 포지션이 있는 경우

1. 현재 보유 종목의 `CandidateSignal`만 우선 확인한다.
2. 보유 종목 신호가 `SELL`이면 sell order intent 생성
3. `HOLD`면 아무 신규 진입도 하지 않음
4. v1에서는 다른 종목의 더 강한 BUY가 떠도 **switching 하지 않음**

즉, v1 정책은 다음과 같다.

- `position exists` → `sell or hold only`
- `flat only` → `new buy allowed`

### Case B. 현재 포지션이 없는 경우

1. 유니버스 전체에서 `signal === BUY` 후보를 수집
2. 아래 필터를 적용
   - `conviction >= minBuyConviction`
   - cooldown 중이 아님
   - synthetic entry bar가 아님 (설정상 허용하지 않는 경우)
   - optional: 스프레드/유동성 조건 충족
3. 남은 후보를 랭킹
4. 최상위 1개만 선택해서 buy order intent 생성

---

## 3.5 BUY 후보 랭킹

전략의 `conviction`이 1차 점수다.
다만 비용과 유동성 때문에 보조 점수를 둘 수 있다.

v1 랭킹 제안:

```typescript
selectionScore =
  0.75 * conviction
+ 0.15 * liquidityBonus
- 0.10 * costPenalty
```

정의 예시:

```typescript
function normalize01(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= low) return 0;
  if (value >= high) return 1;
  return (value - low) / (high - low);
}

const liquidityBonus = normalize01(liquidityScore ?? 0, 0, 1);
const costPenalty = normalize01(estimatedSpreadBps ?? 0, 5, 40);
```

하지만 데이터가 충분치 않다면,
**v1에서는 단순히 conviction 내림차순 + tie-breaker**로 가도 된다.

기본 tie-breaker 순서:
1. higher conviction
2. higher liquidityScore
3. lower estimatedSpreadBps
4. lexical order of market (determinism 보장)

---

## 3.6 cooldown 설계

손절 또는 손실 종료 직후 같은 종목을 다시 바로 사지 않게 해야 한다.

### 기본 정책
- 손실 exit 발생 시 `cooldownUntilByMarket[market] = currentBar + cooldownBarsAfterLoss`
- cooldown 중인 종목은 BUY 후보에서 제외
- 이익 종료 시에는 cooldown을 적용하지 않아도 됨 (설정 가능)

### 추가 가드
- `minBarsBetweenReentry`
- 하루 최대 거래 수 `maxTradesPerDay`

---

## 3.7 Coordinator 알고리즘 의사코드

```typescript
function coordinate(
  state: PortfolioState,
  signals: CandidateSignal[],
  timestamp: number,
  config: CoordinatorConfig
): OrderIntent | null {
  // 1) 현재 포지션이 있으면 해당 종목만 본다.
  if (state.position) {
    const held = signals.find((s) => s.market === state.position?.market);
    if (!held) return null;

    if (held.signal === "SELL") {
      return {
        side: "SELL",
        market: held.market,
        timestamp,
        orderStyle: "best_ioc",
        reason: "signal_exit",
        conviction: Math.max(held.conviction, 0.5),
        targetQuantity: state.position.quantity,
      };
    }

    return null;
  }

  // 2) flat이면 BUY 후보를 모은다.
  const candidates = signals.filter((s) => s.signal === "BUY");

  const eligible = candidates.filter((s) => {
    if (s.conviction < config.minBuyConviction) return false;
    if (config.ignoreSyntheticBarsForEntry && s.metadata?.isSyntheticBar) return false;

    const cooldownUntil = state.cooldownUntilByMarket[s.market] ?? -Infinity;
    if (timestamp < cooldownUntil) return false;

    return true;
  });

  if (eligible.length === 0) return null;

  const ranked = [...eligible].sort(compareCandidates);
  const best = ranked[0];

  return {
    side: "BUY",
    market: best.market,
    timestamp,
    orderStyle: "best_ioc",
    reason: "entry",
    conviction: best.conviction,
  };
}
```

---

# 4. ExecutionSimulator 설계

## 4.1 책임

ExecutionSimulator는 다음을 책임진다.

- OrderIntent를 실제 fill event로 바꾼다.
- same-bar fill 금지 규칙을 적용한다.
- fee/slippage/impact/tick size/min order 제약을 반영한다.
- 미체결/거절/부분체결(선택)을 처리한다.
- 포트폴리오 상태 업데이트에 필요한 fill 결과를 제공한다.

---

## 4.2 비책임

아래는 ExecutionSimulator 책임이 아니다.

- 어떤 종목을 살지 결정
- 전략 신호 계산
- 유니버스 선정
- 포지션 크기 목표 결정 (단, 입력을 검증하는 것은 가능)

---

## 4.3 v1 설계 범위

v1은 **bar-based next-bar simulator**로 구현한다.

지원 범위:
- next-bar fill only
- market 또는 best_ioc 스타일 우선
- tick rounding
- fee model
- impact/slippage model
- minimum order notional reject
- deterministic behavior

보류 범위:
- 정교한 partial fill
- full order book replay
- queue position model
- maker rebate simulation

단, 인터페이스는 v2 확장을 허용해야 한다.

---

## 4.4 제안 인터페이스

```typescript
type ExchangeRules = {
  minOrderNotional: number;
  getTickSize(price: number): number;
  roundPrice(price: number, side: "BUY" | "SELL"): number;
  makerFeeRate: number;
  takerFeeRate: number;
};

type SlippageModelInput = {
  side: "BUY" | "SELL";
  notional: number;
  barOpen: number;
  barHigh: number;
  barLow: number;
  barClose: number;
  barVolume?: number;
  avgDailyNotional?: number;
  estimatedSpreadBps?: number;
  conviction?: number;
};

type ExecutionPolicy = {
  entryOrderStyle: "market" | "best_ioc" | "limit";
  exitOrderStyle: "market" | "best_ioc" | "limit";
  defaultFeeSide: "taker" | "maker";
  decisionToExecutionLagBars: number; // 기본 1
  rejectIfNextBarMissing: boolean; // 기본 true
  maxSlippageBps?: number;
  allowPartialFills?: boolean; // v1 기본 false
};

type FillResult = {
  status: "FILLED" | "REJECTED" | "UNFILLED" | "PARTIAL";
  side: "BUY" | "SELL";
  market: string;
  orderTimestamp: number;
  fillTimestamp?: number;
  requestedQuantity?: number;
  filledQuantity?: number;
  requestedNotional?: number;
  filledNotional?: number;
  fillPrice?: number;
  feePaid?: number;
  slippageBps?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
};
```

---

## 4.5 fill timing 규칙

### 절대 규칙
신호가 발생한 바에서는 절대 체결되지 않는다.

예:
- signal bar index = `t`
- earliest execution bar index = `t + decisionToExecutionLagBars`
- 기본값은 `1`

즉, close 기반 신호면 **다음 바에서만 체결 가능**하다.

---

## 4.6 v1 fill price 규칙

### BUY
- 기본 기준가: `nextBar.open`
- 여기에 spread/impact/slippage를 더해 불리하게 조정
- fee는 별도 차감

### SELL
- 기본 기준가: `nextBar.open`
- 여기에 spread/impact/slippage를 빼 불리하게 조정
- fee는 별도 차감

### 예시

```typescript
const signedSlippage = side === "BUY"
  ? +effectiveSlippageBps
  : -effectiveSlippageBps;

const rawFillPrice = nextBar.open * (1 + signedSlippage / 10_000);
const roundedFillPrice = exchangeRules.roundPrice(rawFillPrice, side);
```

---

## 4.7 slippage model 제안

복잡한 모델보다 먼저 **보수적이고 결정적인 모델**로 시작한다.

```typescript
effectiveSlippageBps =
  baseSpreadHalfBps
+ impactBps
+ urgencyBps
```

### 예시 구성

```typescript
const baseSpreadHalfBps = (estimatedSpreadBps ?? 10) * 0.5;
const notionalParticipation = avgDailyNotional && avgDailyNotional > 0
  ? notional / avgDailyNotional
  : 0;

const impactBps = Math.min(25, Math.sqrt(Math.max(0, notionalParticipation)) * 100);
const urgencyBps = conviction && conviction > 0.85 ? 1.5 : 0.0;
const effectiveSlippageBps = clamp(baseSpreadHalfBps + impactBps + urgencyBps, 0, maxSlippageBps ?? 50);
```

설명:
- 거래 규모가 클수록 impact 증가
- conviction이 아주 높아 공격적 체결을 택하는 경우 약간의 추가 비용 허용
- 상한선을 둬 비정상 폭주 방지

---

## 4.8 fee 적용

fee는 fill price에 섞지 말고 별도 회계 처리한다.

```typescript
const feeRate = policy.defaultFeeSide === "taker"
  ? exchangeRules.takerFeeRate
  : exchangeRules.makerFeeRate;

const grossNotional = roundedFillPrice * filledQuantity;
const feePaid = grossNotional * feeRate;
```

BUY 시:
- 현금 차감 = `grossNotional + feePaid`

SELL 시:
- 현금 증가 = `grossNotional - feePaid`

---

## 4.9 최소 주문 금액 및 reject 처리

BUY/SELL 모두 체결 전 아래를 확인한다.

- `grossNotional >= minOrderNotional`
- 수량 > 0
- 다음 바 데이터 존재

하나라도 실패하면 `REJECTED` 반환.

예시 reason:
- `below_min_order_notional`
- `missing_next_bar`
- `invalid_quantity`
- `insufficient_cash`
- `insufficient_position`

---

## 4.10 tick size rounding

tick size는 거래소 규칙에 맞게 반영한다.

### 기본 원칙
- BUY는 보수적으로 **올림(round up)**
- SELL는 보수적으로 **내림(round down)**

```typescript
function roundPrice(price: number, side: "BUY" | "SELL", tick: number): number {
  if (tick <= 0) return price;
  const scaled = price / tick;
  return side === "BUY"
    ? Math.ceil(scaled) * tick
    : Math.floor(scaled) * tick;
}
```

---

## 4.11 partial fills

v1에서는 partial fill을 기본 비활성화한다.

정책:
- 체결 가능하면 `FILLED`
- 그렇지 않으면 `UNFILLED` 또는 `REJECTED`

다만 인터페이스 상 `PARTIAL` 상태는 남겨서 v2 확장 가능하게 한다.

---

# 5. Portfolio / Execution 연동

## 5.1 권장 백테스트 루프

```typescript
for each decision timestamp t:
  1. build normalized universe snapshot at t
  2. evaluate strategy for every eligible market
  3. send evaluations to PortfolioCoordinator
  4. get zero or one OrderIntent
  5. pass intent to ExecutionSimulator
  6. apply FillResult to portfolio state
  7. update performance ledger / logs
```

중요:
- 전략 평가는 바 종가 기준
- 체결은 `t+1` 이상
- 포트폴리오 상태는 fill 이후 업데이트

---

## 5.2 상태 전이

### Flat state
- `BUY intent` → executed → `Position Open`
- `BUY intent` → rejected/unfilled → remain `Flat`

### Position Open state
- `SELL intent` → executed → `Flat`
- `SELL intent` → rejected/unfilled → remain `Position Open`
- no intent → remain `Position Open`

---

# 6. 테스트 계획

## 6.1 PortfolioCoordinator 테스트

### Test 1. 단일 포지션 강제
입력:
- 3개 종목이 동시에 BUY
- conviction 각각 `0.62`, `0.81`, `0.77`

기대:
- `0.81` 종목만 선택
- order intent는 정확히 1개

### Test 2. 보유 중 신규 BUY 금지
입력:
- 이미 A 보유 중
- A는 HOLD
- B, C는 BUY

기대:
- 신규 BUY 없음

### Test 3. SELL 우선
입력:
- A 보유 중
- A가 SELL
- B가 BUY

기대:
- A SELL intent만 생성

### Test 4. cooldown 적용
입력:
- A가 cooldown 중인데 BUY 발생

기대:
- A 제외

### Test 5. deterministic tie-break
입력:
- conviction 동일
- liquidity 또는 spread로 tie-break

기대:
- 항상 동일 종목 선택

---

## 6.2 ExecutionSimulator 테스트

### Test 1. same-bar fill 금지
입력:
- signal at bar `t`

기대:
- fillTimestamp는 항상 `t+1` 이상

### Test 2. buy fill price 불리 조정
입력:
- next bar open 100
- slippage 10 bps

기대:
- buy fill price >= 100

### Test 3. sell fill price 불리 조정
입력:
- next bar open 100
- slippage 10 bps

기대:
- sell fill price <= 100

### Test 4. tick size rounding
입력:
- tick = 0.1
- buy raw = 100.01
- sell raw = 100.09

기대:
- buy = 100.1
- sell = 100.0

### Test 5. minimum order reject
입력:
- notional < minOrderNotional

기대:
- REJECTED

### Test 6. fee accounting
입력:
- fill notional 1,000,000
- fee rate 0.001

기대:
- fee = 1,000

---

## 6.3 통합 테스트

### Test 1. flat → buy → hold → sell
기대:
- 상태 전이가 올바름
- cash/position 업데이트 일관성 유지

### Test 2. rejected buy 유지
기대:
- 포지션 없음 유지
- cash 변화 없음

### Test 3. cooldown after loss
기대:
- 손실 종료 후 해당 종목 재진입 차단

---

# 7. 구현 우선순위

## Phase 1
- PortfolioCoordinator 구현
- ExecutionSimulator v1 구현
- 백테스트 루프 연결
- 단위 테스트 작성

## Phase 2
- liquidity/spread-aware ranking refinement
- richer reject reasons
- order-style 별 세분화
- richer reporting

## Phase 3
- optional order book simulator
- partial fill model
- maker vs taker path split

---

# 8. 권장 기본 설정

```typescript
const coordinatorConfig: CoordinatorConfig = {
  minBuyConviction: 0.55,
  cooldownBarsAfterLoss: 12,
  minBarsBetweenReentry: 6,
  maxTradesPerDay: 4,
  allowSwitching: false,
  ignoreSyntheticBarsForEntry: true,
};

const executionPolicy: ExecutionPolicy = {
  entryOrderStyle: "best_ioc",
  exitOrderStyle: "best_ioc",
  defaultFeeSide: "taker",
  decisionToExecutionLagBars: 1,
  rejectIfNextBarMissing: true,
  maxSlippageBps: 35,
  allowPartialFills: false,
};
```

---

# 9. 완료 조건

PortfolioCoordinator + ExecutionSimulator 작업 완료로 간주하려면 다음을 만족해야 한다.

- 전략/포트폴리오/체결 계층이 분리되어 있음
- 단일 포지션 제약이 코드상 강제됨
- same-bar fill이 제거됨
- tick/min order/fee/slippage가 simulator에 반영됨
- reject/unfilled 경로가 존재함
- 자동화 테스트가 존재함
- 백테스트 엔진이 이 두 모듈을 실제로 사용함

