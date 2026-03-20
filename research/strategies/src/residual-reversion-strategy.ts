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
    entryThreshold,
    exitThreshold,
    stopLossPct,
    maxHoldBars
  };

  const contextConfig: MarketStateConfig = {
    trendWindow: 50,
    momentumLookback: 20,
    volumeWindow: 20,
    zScoreWindow: 20
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
          // Time-decay: lower exit threshold as position ages to prevent positions stuck open
          const holdRatio = clamp(currentPosition.barsHeld / maxHoldBars, 0, 1);
          const decayedExitThreshold = exitThreshold * (1 - holdRatio * 0.8);
          const exitScore =
            0.60 * clamp(residualZ / 1.5, -1, 1) +
            0.40 * clamp(-momentumSpread / 0.03, -1, 1);

          if (exitScore >= decayedExitThreshold) {
            return { signal: "SELL", conviction: clamp(exitScore, 0.3, 1) };
          }
        }

        // 4. Profit-taking: exit if position has modest gain and approaching hold limit
        if (pnl > 0.005 && currentPosition.barsHeld >= maxHoldBars * 0.6) {
          return { signal: "SELL", conviction: 0.6 };
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
