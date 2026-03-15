# Scored Strategy 설계: 알파 원천 다변화 + 리스크 기반 포지션 관리

## 1. 문서 목적

이 문서는 현재 시스템의 구조적 한계를 진단하고, 실전 수익 가능성을 높이기 위한 설계 변경을 정의한다.

변경 범위:

- 시그널 시스템 확장 (conviction 도입)
- 포지션 사이징 레이어 신규 구축
- 포트폴리오 수준 리스크 관리 도입
- 전략 단순화 (파라미터 10개 이하, 3개 클래스)
- 통계 검증 강화 (bootstrap, 랜덤 벤치마크)
- 체결 모델 개선 (주문 크기 반영 슬리피지)

변경하지 않는 것:

- 기존 레거시 전략 12개 (기준선 비교용으로 유지)
- 데이터 수집기 구조
- 데스크톱 앱 구조 (scored 백테스터 검증 이후 별도 반영)
- 외부 데이터 파이프라인 (호가창, 펀딩비 등은 Phase 2)

## 2. 현재 시스템 진단

### 2.1 알파 원천이 단일하다

12개 전략이 모두 가격과 거래량에서 파생된 기술적 지표만 사용한다.
MA, RSI, z-score, MACD, ADX, Bollinger, Stochastic, CCI, OBV는 모두 동일한 원본 데이터의 변환이다.
독립적인 알파 원천이 하나뿐이므로 전략 수를 늘려도 분산 효과가 거의 없다.

### 2.2 파라미터 과적합이 구조적이다

`integrated-multi-factor` 전략의 파라미터가 45개 이상이다.
walk-forward를 돌려도 45차원 공간에서 좋은 점을 찾는 것은 통계적으로 과적합이다.
파라미터 수 대비 거래 횟수 비율(trade-to-parameter ratio)이 10:1 미만이면 과적합으로 간주한다.

### 2.3 포지션 관리가 없다

- 단일 자산 전략: 100% all-in / all-out
- 유니버스 포트폴리오: 균등 배분만
- 포트폴리오 수준 drawdown 제어 없음
- 자산 간 상관관계 무시
- 진입 시그널의 확신도와 무관하게 동일 비중 배분

### 2.4 체결 모델이 단순하다

- 고정 슬리피지 0.05%
- 주문 크기 무관
- 유동성 미반영

### 2.5 통계 검증이 부족하다

- 수익률 신뢰구간 없음
- 랜덤 진입 대비 비교 없음
- 파라미터 과적합 자동 감지 없음

## 3. 변경 목표

### 목표

1. 전략 복잡도를 줄이고 과적합을 구조적으로 제거한다.
2. 시그널의 확신도에 따라 포지션 크기를 조절한다.
3. 포트폴리오 수준에서 치명적 손실을 방지한다.
4. 백테스트 결과의 통계적 유의성을 자동 검증한다.
5. 체결 모델을 주문 크기 기반으로 현실화한다.

### 비목표

- 새로운 외부 데이터 소스 연동 (Phase 2)
- 페이퍼 트레이더 변경 (scored 백테스터 검증 이후)
- 데스크톱 앱 변경 (서비스 계층 안정 이후)
- 기존 레거시 전략 수정

## 4. 핵심 설계 변경

### 4.1 시그널 시스템: Signal -> SignalResult

기존:

```typescript
type Signal = "BUY" | "SELL" | "HOLD";
generateSignal(context): Signal;
```

변경:

```typescript
type SignalResult = {
  signal: Signal;
  conviction: number; // 0.0~1.0, 시그널 확신도
};

type ScoredStrategy = {
  name: string;
  parameters: Record<string, number>;
  parameterCount: number;
  contextConfig?: MarketStateConfig;
  generateSignal(context: StrategyContext): SignalResult;
};
```

설계 원칙:

- conviction은 포지션 사이징의 입력값으로만 사용한다.
- conviction=0은 HOLD와 동일하게 취급한다.
- 기존 레거시 전략은 어댑터를 통해 conviction=1로 래핑한다.

### 4.2 포지션 사이징: PositionSizer

기존: 시그널이 BUY이면 전 자금 투입
변경: 변동성과 확신도 기반 비중 결정

```typescript
type PositionSizeRequest = {
  conviction: number;
  currentPrice: number;
  atr: number;
  portfolioEquity: number;
  currentPositionValue: number;
};

type PositionSizeResult = {
  targetWeight: number; // 0.0~1.0, 포트폴리오 대비 비중
  reason: string;
};

type PositionSizer = {
  name: string;
  calculate(request: PositionSizeRequest): PositionSizeResult;
};
```

구현된 사이저:

- **volatility-target**: 변동성 타겟팅. ATR 기반으로 비중을 결정한다.
  - `targetWeight = min(maxWeight, (targetVolatility / currentVolatility) * conviction)`
  - 변동성이 높으면 비중을 줄이고, 낮으면 키운다.

### 4.3 포트폴리오 리스크: DrawdownCircuitBreaker

기존: 없음
변경: 포트폴리오 수준 drawdown 차단기

```typescript
type PortfolioRiskCheck = {
  canOpenNew: boolean;
  mustLiquidateAll: boolean;
  maxExposure: number; // 0.0~1.0
  reason: string;
};

type PortfolioRiskManager = {
  name: string;
  check(params: {
    currentEquity: number;
    peakEquity: number;
    currentExposure: number;
  }): PortfolioRiskCheck;
  onBarClose(equity: number): void;
};
```

동작:

- 포트폴리오 drawdown이 `warnThreshold`(5%) 초과 시: 신규 진입 차단, 최대 노출도 제한
- 포트폴리오 drawdown이 `killThreshold`(10%) 초과 시: 전 포지션 강제 청산
- 청산 후 `cooldownBars`(48) 동안 거래 중지

### 4.4 전략 단순화: Scored 전략 3개

모든 scored 전략은 파라미터 10개 이하, SignalResult를 반환한다.

#### momentum (추세 추종)

논리: 모멘텀 상위 종목 매수, 모멘텀 붕괴 시 청산

파라미터 (6개):

- `fastWindow`: 10 (단기 EMA)
- `slowWindow`: 50 (장기 EMA)
- `momentumLookback`: 20 (모멘텀 측정 기간)
- `atrPeriod`: 14 (변동성 측정)
- `atrMultiplier`: 2.0 (트레일링 스톱 배수)
- `maxVolatility`: 0.05 (최대 진입 변동성)

conviction 계산: EMA 이격도, 모멘텀 크기, ADX 강도의 평균

#### mean-reversion (평균 회귀)

논리: 단기 과매도 진입, 평균 복귀 시 청산

파라미터 (7개):

- `zScoreWindow`: 20
- `entryZScore`: -2.0 (진입 임계값)
- `exitZScore`: 0.0 (청산 임계값)
- `rsiPeriod`: 14
- `maxEntryRsi`: 30 (최대 진입 RSI)
- `stopLossPct`: 0.03 (손절)
- `maxHoldBars`: 24 (최대 보유 기간)

conviction 계산: z-score 깊이와 RSI 극단성의 평균

#### trend-pullback (추세 내 눌림목)

논리: 상승 추세 종목에서 일시적 조정 시 진입

파라미터 (7개):

- `trendWindow`: 50 (추세 판단 EMA)
- `momentumLookback`: 20 (모멘텀 확인)
- `minMomentum`: -0.01 (최소 모멘텀)
- `zScoreWindow`: 20 (과매도 측정)
- `entryZScore`: -1.5 (진입 z-score)
- `stopLossPct`: 0.025 (손절)
- `maxHoldBars`: 36 (최대 보유)

conviction 계산: 추세 강도, 모멘텀 유지도, z-score 깊이의 가중 평균

### 4.5 체결 모델 개선

기존: 고정 슬리피지
변경: 주문 크기 기반 동적 슬리피지

슬리피지 공식:

```
effectiveSlippage = baseSlippage * (1 + orderNotional / dailyNotional)
```

주문 금액이 일평균 거래대금의 1%를 초과하면 슬리피지가 비선형으로 증가한다.

### 4.6 통계 검증: Bootstrap + Random Benchmark

#### Bootstrap 신뢰구간

방법:

1. 거래 수익률 시퀀스를 추출한다.
2. N회(기본 5000) 복원 추출하여 가상 수익률 분포를 만든다.
3. 관찰된 수익률이 분포 내에서 어디에 위치하는지 계산한다.
4. 95% 신뢰구간과 p-value를 보고한다.

#### 랜덤 벤치마크

방법:

1. 전략의 평균 거래 빈도를 계산한다.
2. 동일 빈도로 랜덤 진입/청산하는 가상 전략을 N회(기본 1000) 실행한다.
3. 전략 수익률이 랜덤 대비 어느 백분위에 있는지 보고한다.
4. 90%ile 미만이면 경고를 발생한다.

## 5. 파일 구조

### Scored 전략 파일

```
research/strategies/src/
  position-sizer.ts          # PositionSizer 구현
  portfolio-risk.ts          # PortfolioRiskManager 구현
  momentum-strategy.ts       # 추세 추종 전략
  mean-reversion-strategy.ts # 평균 회귀 전략
  trend-pullback-strategy.ts # 추세 눌림목 전략

research/backtester/src/
  scored-engine.ts           # Scored 백테스터 엔진
  scored-runner.ts           # Scored 실행기 (holdout + walk-forward)
  db-scored.ts               # Scored 결과 DB 저장
  bootstrap.ts               # Bootstrap 신뢰구간
  random-benchmark.ts        # 랜덤 진입 벤치마크
```

## 6. CLI 사용법

```bash
# 단일 전략 기준선 평가 (bootstrap + random benchmark 포함)
pnpm --filter @fst/backtester dev \
  --scored-baseline \
  --strategy trend-pullback \
  --timeframe 5m \
  --universe krw-top \
  --market-limit 10

# 전략 전체 파라미터 스윕
pnpm --filter @fst/backtester dev \
  --scored-sweep --sweep-all \
  --timeframe 1h \
  --universe krw-top \
  --market-limit 10 \
  --save-regime

# Walk-forward 검증
pnpm --filter @fst/backtester dev \
  --scored-walk-forward --sweep-all \
  --timeframe 5m \
  --universe krw-top \
  --market-limit 10 \
  --training-days 30 \
  --holdout-days 14
```

## 7. 마이그레이션 규칙

- 기존 레거시 전략은 삭제하지 않는다.
- 레거시 전략은 기준선 비교용으로 유지한다.
- scored 전략은 `createScoredStrategyByName`으로 접근한다.
- scored 엔진은 `scored-engine.ts`로 분리하여 기존 엔진과 공존한다.

## 8. 성공 기준

1. scored 전략의 파라미터가 모두 10개 이하이다.
2. trade-to-parameter ratio가 10:1 이상인 경우에만 결과를 신뢰한다.
3. bootstrap p-value < 0.05인 경우에만 전략을 후보로 인정한다.
4. 랜덤 벤치마크 90%ile 이상인 경우에만 전략을 후보로 인정한다.
5. 포트폴리오 drawdown이 killThreshold를 초과하면 자동 청산된다.
6. 포지션 비중이 conviction과 변동성에 따라 조절된다.
