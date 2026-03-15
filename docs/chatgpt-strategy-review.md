# Crypto Trading Strategy Review Request

## 배경

업비트(한국 거래소) KRW 마켓에서 자동매매를 위한 전략 시스템을 개발 중입니다.
현재 "residual-reversion" (잔차 평균 회귀) 전략을 구현했으나 백테스트 결과가 좋지 않습니다.
전략 로직, 팩터 설계, 파라미터 구조에 대한 개선안을 요청합니다.

## 시스템 아키텍처

### 데이터
- **거래소**: 업비트 (Upbit) KRW 마켓
- **타임프레임**: 5분봉, 1시간봉
- **유니버스**: KRW 시가총액 상위 20개 코인 (BTC, ETH, XRP, SOL 등)
- **데이터 양**: 5분봉 기준 코인당 최대 420,000개 (약 4~5년치)

### 백테스트 구조
- **방식**: Holdout validation (training/test split by days)
- **테스트 기간**: 최근 30일
- **훈련 기간**: 5m은 60일, 1h는 90일
- **검증**: Bootstrap p-value, Random benchmark percentile
- **수수료**: 0.1% per side (업비트 기본)
- **슬리피지**: 동적 (주문 규모 / 일평균 거래대금 비율 기반)
- **포지션 사이징**: volatility-target sizer (ATR 기반, maxWeight: 0.25)

### 유니버스 Market State 시스템
각 바(bar)마다 유니버스 전체의 시장 상태를 계산합니다:

**Breadth (시장 폭):**
- advancingRatio: 상승 종목 비율
- aboveTrendRatio: EMA 위에 있는 종목 비율
- positiveMomentumRatio: 양수 모멘텀 종목 비율
- averageMomentum, averageZScore, averageVolumeSpike
- compositeTrendScore, riskOnScore

**RelativeStrength (상대 강도) — 전략이 사용하는 핵심 데이터:**
- `zScoreSpread`: 해당 코인의 z-score - 유니버스 평균 z-score (상대적 과매도/과매수)
- `cohortMomentumSpread`: 해당 코인의 모멘텀 - 유니버스 평균 모멘텀 (상대적 모멘텀)
- `volumeSpikeSpread`: 거래량 스파이크 비율 차이
- `momentumPercentile`: 유니버스 내 모멘텀 백분위
- `returnPercentile`: 유니버스 내 수익률 백분위

**데이터 분포 (실제 5m 데이터에서 측정):**
- zScoreSpread: 범위 [-6.07, 4.75], 평균 ~0
- cohortMomentumSpread: 범위 [-0.146, 0.355], 평균 ~0
- volumeRollingZ (자체 계산): 범위 [-1.5, 3.9]

## 현재 전략: residual-reversion

### 논리
유니버스 대비 상대적으로 과매도된 코인을 매수하고, 잔차가 평균으로 복귀하면 매도.

### 전략 코드 (TypeScript)

```typescript
import { getVolumeSpikeRatio } from "./factors/index.js";
import type { MarketStateConfig, SignalResult, StrategyContext, ScoredStrategy } from "./types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 거래량 롤링 z-score 계산
 * 최근 volumeWindow 기간의 거래량 스파이크 비율을 z-score로 변환
 */
function getVolumeRollingZ(
  candles: StrategyContext["candles"],
  index: number,
  volumeWindow: number
): number | null {
  if (index < volumeWindow) return null;

  const ratios: number[] = [];
  for (let i = index - volumeWindow + 1; i <= index; i++) {
    const ratio = getVolumeSpikeRatio(candles, i, volumeWindow);
    if (ratio !== null) ratios.push(ratio);
  }

  if (ratios.length < volumeWindow * 0.5) return null;

  const mean = ratios.reduce((s, v) => s + v, 0) / ratios.length;
  const variance = ratios.reduce((s, v) => s + (v - mean) ** 2, 0) / ratios.length;
  const std = Math.sqrt(variance);

  if (std < 1e-10) return 0;

  const currentRatio = getVolumeSpikeRatio(candles, index, volumeWindow);
  if (currentRatio === null) return null;

  return (currentRatio - mean) / std;
}

export function createResidualReversionStrategy(params?: {
  entryThreshold?: number;
  exitThreshold?: number;
  stopLossPct?: number;
  maxHoldBars?: number;
}): ScoredStrategy {
  const entryThreshold = params?.entryThreshold ?? 0.25;
  const exitThreshold = params?.exitThreshold ?? 0.15;
  const stopLossPct = params?.stopLossPct ?? 0.025;
  const maxHoldBars = params?.maxHoldBars ?? 36;

  const parameters: Record<string, number> = {
    entryThreshold, exitThreshold, stopLossPct, maxHoldBars
  };

  const contextConfig: MarketStateConfig = {
    trendWindow: 50, momentumLookback: 20, volumeWindow: 20, zScoreWindow: 20
  };

  return {
    name: "residual-reversion",
    parameters,
    parameterCount: 4,
    contextConfig,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition, marketState } = context;
      const close = candles[index]?.closePrice;

      if (close === undefined || close === 0) {
        return { signal: "HOLD", conviction: 0 };
      }

      const rs = marketState?.relativeStrength;
      const residualZ = rs?.zScoreSpread ?? null;
      const momentumSpread = rs?.cohortMomentumSpread ?? null;
      const volumeRollingZ = getVolumeRollingZ(candles, index, 20);

      // 포지션 보유 중: 청산 판단
      if (hasPosition && currentPosition) {
        const pnl = (close - currentPosition.entryPrice) / currentPosition.entryPrice;

        // 1. 손절
        if (pnl <= -stopLossPct) {
          return { signal: "SELL", conviction: 1.0 };
        }

        // 2. 최대 보유 기간 초과
        if (currentPosition.barsHeld >= maxHoldBars) {
          return { signal: "SELL", conviction: 0.7 };
        }

        // 3. 잔차 복귀 + 모멘텀 약화 → 청산
        if (residualZ !== null && momentumSpread !== null) {
          const exitScore =
            0.60 * clamp(residualZ / 1.5, -1, 1) +
            0.40 * clamp(-momentumSpread / 0.03, -1, 1);

          if (exitScore >= exitThreshold) {
            return { signal: "SELL", conviction: clamp(exitScore, 0.3, 1) };
          }
        }

        return { signal: "HOLD", conviction: 0 };
      }

      // 시장 상태 데이터 없으면 진입 불가
      if (residualZ === null || momentumSpread === null || volumeRollingZ === null) {
        return { signal: "HOLD", conviction: 0 };
      }

      // 진입 점수 계산
      const entryScore =
        0.40 * clamp(-residualZ / 1.5, -1, 1) +
        0.30 * clamp(momentumSpread / 0.03, -1, 1) +
        0.30 * clamp(volumeRollingZ / 2.0, -1, 1);

      if (entryScore >= entryThreshold) {
        return {
          signal: "BUY",
          conviction: clamp(entryScore, 0.1, 1)
        };
      }

      return { signal: "HOLD", conviction: 0 };
    }
  };
}
```

### 팩터 3개 (고정 가중치)

| 팩터 | 소스 | 가중치 | 정규화 | 의미 |
|------|------|--------|--------|------|
| 잔차 z-score | `zScoreSpread` | 0.40 | `/1.5, clamp[-1,1]` | 유니버스 대비 상대 과매도 |
| 모멘텀 잔차 | `cohortMomentumSpread` | 0.30 | `/0.03, clamp[-1,1]` | 상대 모멘텀 회복 |
| 거래량 확인 | `volumeRollingZ` (자체 계산) | 0.30 | `/2.0, clamp[-1,1]` | 거래량 이상치 |

### 파라미터 그리드 (108 조합)

```
entryThreshold: [0.15, 0.20, 0.25, 0.30]    (4)
exitThreshold:  [0.10, 0.15, 0.20]           (3)
stopLossPct:    [0.020, 0.025, 0.030]         (3)
maxHoldBars:    [24, 36, 48]                   (3)
```

## 백테스트 결과

### 5분봉 (30일 테스트, 60일 훈련, 20개 마켓)

| 항목 | 값 |
|------|-----|
| 최고 수익률 | **-3.96%** |
| 거래 수 (평균/마켓) | **715건** (하루 ~24건) |
| Bootstrap 통과율 | **0%** |
| Random 벤치마크 통과율 | **78.9%** (90% 미달) |

### 1시간봉 (30일 테스트, 90일 훈련, 20개 마켓)

| 항목 | 값 |
|------|-----|
| 최고 수익률 | **-0.08%** |
| 거래 수 (평균/마켓) | **89건** (하루 ~3건) |
| Bootstrap 통과율 | **5.3%** |
| Random 벤치마크 통과율 | **15.8%** |

### 핵심 관찰
- 108개 파라미터 조합 모두 음수 수익률
- 5m에서 거래 빈도가 극도로 높음 (entryThreshold 0.15일 때 바의 26%가 진입 신호)
- 파라미터 변화에 대한 민감도가 낮음 (모든 조합이 비슷한 결과)
- 수수료+슬리피지가 수익을 갉아먹는 구조

## 사용 가능한 팩터/인디케이터

시스템에서 사용 가능한 기술적 팩터들:

```
// 평균 회귀
getRsi(candles, index, period)
getZScore(candles, index, window)

// 이동평균
getEma(candles, index, window)
getSma(candles, index, window)

// 모멘텀
getMomentum(candles, index, lookback)  // (close - close[lookback]) / close[lookback]
getPriceSlope(candles, index, window)
getRateOfChange(candles, index, period)

// 오실레이터
getBollingerBands(candles, index, window, multiplier)
getCci(candles, index, window)
getStochasticOscillator(candles, index, kPeriod, dPeriod)

// 추세
getAdx(candles, index, period)  // { adx, plusDi, minusDi }
getDonchianChannel(candles, index, period)
getMacd(candles, index, fastPeriod, slowPeriod, signalPeriod)

// 변동성
getAtr(candles, index, period)
getHistoricalVolatility(candles, index, window)
getRangeExpansionScore(candles, index, window)

// 거래량
getAverageVolume(candles, index, window)
getVolumeSpikeRatio(candles, index, window)
getObv(candles, index)
getObvSlope(candles, index, window)

// 레짐
detectMarketRegime(candles, index, config)  // "trend_up" | "trend_down" | "range" | "volatile"
```

### 유니버스 Market State (RelativeStrength) 필드:
```
zScoreSpread            // 코인 z-score - 유니버스 평균
cohortMomentumSpread    // 코인 모멘텀 - 유니버스 평균
cohortZScoreSpread      // (= zScoreSpread)
cohortVolumeSpikeSpread // 거래량 스파이크 차이
momentumPercentile      // 유니버스 내 모멘텀 백분위 (0~1)
returnPercentile        // 유니버스 내 수익률 백분위 (0~1)
compositeMomentumSpread // 벤치마크 대비 모멘텀 차이
compositeChangeSpread   // 벤치마크 대비 변화율 차이
liquiditySpread         // 유동성 차이
```

### 유니버스 Breadth 필드:
```
advancingRatio          // 상승 종목 비율
aboveTrendRatio         // EMA 위 종목 비율
positiveMomentumRatio   // 양수 모멘텀 비율
averageMomentum         // 유니버스 평균 모멘텀
compositeTrendScore     // 종합 추세 점수 [-1, 1]
riskOnScore             // 리스크온 점수 [-1, 1]
dispersionScore         // 분산도 점수
```

### Composite (유니버스 종합 벤치마크):
```
regime                  // "trend_up" | "trend_down" | "range" | "volatile" | "unknown"
momentum                // 유니버스 평균 모멘텀
trendScore              // 종합 추세 점수
```

## 제약 조건

1. **롱 전용** (숏 불가, 업비트 현물)
2. **단일 포지션** (한 시점에 한 종목만 보유)
3. **전략은 `ScoredStrategy` 인터페이스** 준수 (signal: BUY/SELL/HOLD, conviction: 0~1)
4. **파라미터 수 최소화** (과적합 방지, trade-to-parameter ratio >= 10 필요)
5. **유니버스 데이터는 이미 계산되어 있음** (marketState로 전달됨)
6. **포지션 사이징은 외부에서 처리** (전략은 signal + conviction만 반환)

## 요청사항

1. **현재 전략의 근본적 문제점 분석** — 왜 모든 파라미터에서 음수 수익이 나오는가?
2. **개선된 전략 로직 제안** — 같은 데이터(유니버스 market state + 기술적 지표)를 활용하되, 실제로 엣지가 있을 수 있는 구조
3. **진입/청산 로직의 구체적 코드 수준 개선안**
4. **파라미터 그리드 제안** — 과적합을 피하면서 충분한 탐색이 가능한 범위
5. **추가로 고려해야 할 필터나 조건** (예: 시장 레짐 필터, 최소 거래량 필터 등)

TypeScript 코드로 제안해주면 가장 좋습니다. `ScoredStrategy` 인터페이스를 따라야 합니다:

```typescript
type ScoredStrategy = {
  name: string;
  parameters: Record<string, number>;
  parameterCount: number;
  contextConfig?: MarketStateConfig;
  generateSignal(context: StrategyContext): SignalResult;
};

type SignalResult = {
  signal: "BUY" | "SELL" | "HOLD";
  conviction: number;  // 0~1
};

type StrategyContext = {
  candles: Candle[];
  index: number;
  hasPosition: boolean;
  currentPosition?: { entryPrice: number; quantity: number; barsHeld: number; };
  marketState?: MarketStateContext;
};
```
