import type { Strategy, StrategyContext, StrategySignal } from "../../../../packages/shared/src/index.js";

function highestHigh(candles: StrategyContext["featureView"]["candles"], endIndex: number, lookbackBars: number): number | null {
  const start = endIndex - lookbackBars;
  if (start < 0) {
    return null;
  }

  let highest = Number.NEGATIVE_INFINITY;
  for (let index = start; index < endIndex; index += 1) {
    highest = Math.max(highest, candles[index]?.highPrice ?? Number.NEGATIVE_INFINITY);
  }

  return Number.isFinite(highest) ? highest : null;
}

export function createMicroBreakoutStrategy(params?: {
  strategyId?: string;
  sleeveId?: "micro";
  lookbackBars?: number;
  extensionThreshold?: number;
  holdingBarsMax?: number;
  stopAtrMult?: number;
  minVolumeSpike?: number;
  minRiskOnScore?: number;
  minLiquidityScore?: number;
  minBreakoutDistance?: number;
  maxBreakoutDistance?: number;
  requireCloseNearHigh?: number;
  profitTarget?: number;
}): Strategy {
  const strategyId = params?.strategyId ?? "micro-breakout";
  const sleeveId = params?.sleeveId ?? "micro";
  const lookbackBars = params?.lookbackBars ?? 8;
  const extensionThreshold = params?.extensionThreshold ?? 0.003;
  const holdingBarsMax = params?.holdingBarsMax ?? 10;
  const stopAtrMult = params?.stopAtrMult ?? 1.2;
  const minVolumeSpike = params?.minVolumeSpike ?? 0.9;
  const minRiskOnScore = params?.minRiskOnScore ?? 0;
  const minLiquidityScore = params?.minLiquidityScore ?? 0.01;
  const minBreakoutDistance = params?.minBreakoutDistance ?? extensionThreshold * 0.35;
  const maxBreakoutDistance = params?.maxBreakoutDistance ?? extensionThreshold * 1.6;
  const requireCloseNearHigh = params?.requireCloseNearHigh ?? 0.65;
  const profitTarget = params?.profitTarget ?? extensionThreshold * 1.2;

  return {
    id: strategyId,
    sleeveId,
    family: "micro",
    decisionTimeframe: "1m",
    executionTimeframe: "1m",
    parameters: {
      lookbackBars,
      extensionThreshold,
      holdingBarsMax,
      stopAtrMult,
      minVolumeSpike,
      minRiskOnScore,
      minLiquidityScore,
      minBreakoutDistance,
      maxBreakoutDistance,
      requireCloseNearHigh,
      profitTarget
    },
    generateSignal(context: StrategyContext): StrategySignal {
      const candle = context.featureView.candles[context.featureView.decisionIndex];
      const previous = context.featureView.candles[context.featureView.decisionIndex - 1];
      const breakoutLevel = highestHigh(
        context.featureView.candles,
        context.featureView.decisionIndex,
        lookbackBars
      );
      const close = candle?.closePrice ?? 0;
      const open = candle?.openPrice ?? close;
      const move = open === 0 ? 0 : (close - open) / open;
      const volume = candle?.volume ?? 0;
      const trailing = context.featureView.trailingCandles.slice(-lookbackBars);
      const avgVolume =
        trailing.length === 0 ? 0 : trailing.reduce((sum, item) => sum + item.volume, 0) / trailing.length;
      const volumeSpike = avgVolume <= 0 ? 0 : volume / avgVolume;
      const breakoutDistance = breakoutLevel === null || breakoutLevel <= 0 ? 0 : (close - breakoutLevel) / breakoutLevel;
      const barRange = Math.max(0, (candle?.highPrice ?? close) - (candle?.lowPrice ?? close));
      const closeInBar = barRange <= 0 ? 0.5 : (close - (candle?.lowPrice ?? close)) / barRange;
      const riskOnScore = Number(
        ((context.marketState as { breadth?: { riskOnScore?: number } } | undefined)?.breadth?.riskOnScore) ?? 0
      );
      const liquidityScore = Number(
        ((context.marketState as { breadth?: { liquidityScore?: number } } | undefined)?.breadth?.liquidityScore) ?? 0
      );

      let signal: StrategySignal["signal"] = "HOLD";
      let reason = "micro_wait";

      if (context.existingPosition?.market === context.market) {
        const entryPrice = context.existingPosition.entryPrice;
        const pnl = entryPrice > 0 ? (close - entryPrice) / entryPrice : 0;
        const barsHeld = Math.max(
          0,
          Math.round((context.decisionTime.getTime() - context.existingPosition.entryTime.getTime()) / 60_000)
        );
        const breakoutFailed =
          breakoutLevel !== null &&
          close < breakoutLevel &&
          previous !== undefined &&
          previous.closePrice < previous.openPrice;
        const stopHit = pnl <= -extensionThreshold * stopAtrMult;
        const timedExit = barsHeld >= holdingBarsMax;
        const reversalAfterPop = pnl >= profitTarget && move < 0 && closeInBar < 0.5;

        if (timedExit || stopHit || breakoutFailed || reversalAfterPop) {
          signal = "SELL";
          reason = "micro_exit";
        }
      } else if (
        breakoutLevel !== null &&
        close > breakoutLevel &&
        breakoutDistance >= minBreakoutDistance &&
        breakoutDistance <= maxBreakoutDistance &&
        move > 0 &&
        volumeSpike >= minVolumeSpike &&
        riskOnScore >= minRiskOnScore &&
        liquidityScore >= minLiquidityScore &&
        closeInBar >= requireCloseNearHigh &&
        !candle?.isSynthetic
      ) {
        signal = "BUY";
        reason = "micro_breakout";
      }

      return {
        strategyId: "micro-breakout",
        sleeveId: "micro",
        family: "micro",
        market: context.market,
        signal,
        conviction: Math.max(0, Math.min(1, Math.abs(move) / Math.max(extensionThreshold, 0.0001))),
        decisionTime: context.decisionTime,
        decisionTimeframe: "1m",
        executionTimeframe: "1m",
        reason,
        stages: {
          universe_eligible: true,
          setup_pass:
            breakoutLevel !== null &&
            volumeSpike >= minVolumeSpike &&
            riskOnScore >= minRiskOnScore &&
            liquidityScore >= minLiquidityScore &&
            closeInBar >= requireCloseNearHigh,
          trigger_pass: signal !== "HOLD"
        },
        metadata: {
          liquidityScore,
          volumeSpike,
          riskOnScore,
          breakoutDistance,
          closeInBar
        }
      };
    }
  };
}
