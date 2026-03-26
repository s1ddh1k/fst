// Auto-generated strategy: ADX Momentum Breakout with Donchian Channel
// Thesis: If ADX crosses above 25 while price breaks above the 20-period Donchian high, then a long entry held until ADX drops below 20 will capture 2-5% net per window, because strong trending periods in crypto are persistent and identifiable via directional strength
// Generated at: 2026-03-24T15:30:54.677Z

import type {
  Strategy,
  StrategyContext,
  StrategySignal,
  StrategyTimeframe
} from "../../../../packages/shared/src/index.js";
import type { Candle } from "../types.js";
import type { GeneratedStrategyModule, GeneratedStrategyMetadata } from "../auto-research/strategy-template.js";

// Indicator imports (all available — unused ones are tree-shaken)
import {
  getRsi, getZScore, getEma, getSma, getMomentum, getPriceSlope, getRateOfChange,
  getBollingerBands, getCci, getStochasticOscillator, detectMarketRegime, matchesRegime,
  getAdx, getDonchianChannel, getMacd, getAtr, getHistoricalVolatility, getRangeExpansionScore,
  getAverageVolume, getVolumeSpikeRatio, getObv, getObvSlope
} from "../../../../research/strategies/src/factors/index.js";

// Parameter specifications:
  // ADX calculation period (10 - 30)
  // ADX level that must be crossed upward to confirm trend strength for entry (20 - 35)
  // ADX level below which trend is considered exhausted, triggering exit (12 - 22)
  // Lookback period for Donchian Channel high/low bands (14 - 40)
  // ATR period used for stop-loss and take-profit distance (10 - 20)
  // ATR multiplier for trailing stop-loss distance below price (1.5 - 3.5)
  // ATR multiplier for take-profit target above entry price (2 - 6)
  // Number of consecutive bars ADX must be rising to confirm strengthening trend (1 - 4)

export const metadata: GeneratedStrategyMetadata = {
  familyId: "generated:block:adx-momentum-breakout-1h",
  strategyName: "generated-block-adx-momentum-breakout-1h",
  title: "ADX Momentum Breakout with Donchian Channel",
  thesis: "If ADX crosses above 25 while price breaks above the 20-period Donchian high, then a long entry held until ADX drops below 20 will capture 2-5% net per window, because strong trending periods in crypto are persistent and identifiable via directional strength",
  family: "breakout",
  sleeveId: "breakout",
  decisionTimeframe: "1h" as StrategyTimeframe,
  executionTimeframe: "5m" as StrategyTimeframe,
  parameterSpecs: [
  {
    "name": "adxPeriod",
    "description": "ADX calculation period",
    "min": 10,
    "max": 30
  },
  {
    "name": "adxEntryThreshold",
    "description": "ADX level that must be crossed upward to confirm trend strength for entry",
    "min": 20,
    "max": 35
  },
  {
    "name": "adxExitThreshold",
    "description": "ADX level below which trend is considered exhausted, triggering exit",
    "min": 12,
    "max": 22
  },
  {
    "name": "donchianPeriod",
    "description": "Lookback period for Donchian Channel high/low bands",
    "min": 14,
    "max": 40
  },
  {
    "name": "atrPeriod",
    "description": "ATR period used for stop-loss and take-profit distance",
    "min": 10,
    "max": 20
  },
  {
    "name": "atrStopMultiplier",
    "description": "ATR multiplier for trailing stop-loss distance below price",
    "min": 1.5,
    "max": 3.5
  },
  {
    "name": "atrTakeProfitMultiplier",
    "description": "ATR multiplier for take-profit target above entry price",
    "min": 2,
    "max": 6
  },
  {
    "name": "adxRisingBars",
    "description": "Number of consecutive bars ADX must be rising to confirm strengthening trend",
    "min": 1,
    "max": 4
  }
],
  regimeGate: {"allowedRegimes":["trend_up","breakout"]}
};

export function createStrategy(params: {
  strategyId: string;
  parameters: Record<string, number>;
}): Strategy {
  const p = {
    adxPeriod: params.parameters.adxPeriod ?? 20,
    adxEntryThreshold: params.parameters.adxEntryThreshold ?? 27.5,
    adxExitThreshold: params.parameters.adxExitThreshold ?? 17,
    donchianPeriod: params.parameters.donchianPeriod ?? 27,
    atrPeriod: params.parameters.atrPeriod ?? 15,
    atrStopMultiplier: params.parameters.atrStopMultiplier ?? 2.5,
    atrTakeProfitMultiplier: params.parameters.atrTakeProfitMultiplier ?? 4,
    adxRisingBars: params.parameters.adxRisingBars ?? 2.5
  };

  return {
    id: params.strategyId,
    sleeveId: metadata.sleeveId,
    family: metadata.family,
    decisionTimeframe: metadata.decisionTimeframe,
    executionTimeframe: metadata.executionTimeframe,
    parameters: params.parameters,

    generateSignal(context: StrategyContext): StrategySignal {
      const candles = context.featureView.candles;
      const idx = context.featureView.decisionIndex;
      const market = context.market;
      const hasPosition = context.existingPosition != null;
      const entryPrice = context.existingPosition?.entryPrice ?? 0;
      const barsHeld = hasPosition && context.existingPosition?.entryTime
        ? Math.floor((context.decisionTime.getTime() - context.existingPosition.entryTime.getTime()) / (3600 * 1000))
        : 0;

      // ============================================================
      // TODO: LLM fills in signal generation logic here
      // Strategy: On each 1h bar close, compute ADX(adxPeriod), Donchian Channel(donchianPeriod), and ATR(atrPeriod). ENTRY: A buy signal fires when ALL of the following are true: (1) ADX crosses above adxEntryThreshold from below on the current bar, OR ADX is already above adxEntryThreshold and has been rising for at least adxRisingBars consecutive bars; (2) the current close is above or equal to the Donchian Channel upper band (highest high of last donchianPeriod bars); (3) +DI is greater than -DI, confirming the directional move is bullish. Conviction score is calculated as: clamp((ADX - adxEntryThreshold) / 25, 0.3, 1.0) * (if close > donchianUpper by more than 0.5 * ATR then 1.0 else 0.7). EXIT: Sell when ANY of the following occur: (1) ADX drops below adxExitThreshold — trend exhaustion; (2) price drops below entry price minus atrStopMultiplier * ATR at entry — stop-loss; (3) price reaches entry price plus atrTakeProfitMultiplier * ATR at entry — take-profit; (4) +DI crosses below -DI while ADX is declining — bearish directional reversal. The trailing stop is activated once price moves 1×ATR above entry: the stop ratchets up to max(previous stop, highest close since entry minus atrStopMultiplier * ATR).
      //
      // Candle fields: .openPrice, .highPrice, .lowPrice, .closePrice, .volume
      // Indicator usage: fn(candles, idx, period) → number|null. Always ?? defaultValue.
      // Must return signal: "BUY", "SELL", or "HOLD"
      // conviction: 0.0 to 1.0
      // ============================================================

      let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
      let conviction = 0;
      let reason = "no signal";

      // ADX Momentum Breakout with Donchian Channel
if (idx < 30) { signal = "HOLD"; conviction = 0; reason = "warmup"; }
else {
  const close = candles[idx].closePrice;
  const adxNow = getAdx(candles, idx, p.adxPeriod);
  const adxPrev = getAdx(candles, idx - 1, p.adxPeriod);
  const donchian = getDonchianChannel(candles, idx, p.donchianPeriod);
  const atr = getAtr(candles, idx, p.atrPeriod);

  if (!adxNow || !adxPrev || !donchian || !atr) { signal = "HOLD"; conviction = 0; reason = "indicator null"; }
  else if (!hasPosition) {
    // Entry logic
    const adxCrossedUp = adxNow.adx > p.adxEntryThreshold && adxPrev.adx <= p.adxEntryThreshold;

    // ADX rising for consecutive bars
    let adxRising = true;
    for (let i = 0; i < p.adxRisingBars; i++) {
      const a1 = getAdx(candles, idx - i, p.adxPeriod);
      const a2 = getAdx(candles, idx - i - 1, p.adxPeriod);
      if (!a1 || !a2 || a1.adx <= a2.adx) { adxRising = false; break; }
    }
    const adxStrongAndRising = adxNow.adx > p.adxEntryThreshold && adxRising;

    const bullishDirection = adxNow.plusDi > adxNow.minusDi;
    const priceBreakout = close >= donchian.upper;

    if ((adxCrossedUp || adxStrongAndRising) && priceBreakout && bullishDirection) {
      signal = "BUY";
      conviction = Math.min(1.0, Math.max(0.3, (adxNow.adx - p.adxEntryThreshold) / 25));
      if (close > donchian.upper + 0.5 * atr) {
        conviction *= 1.0;
      } else {
        conviction *= 0.7;
      }
      conviction = Math.min(1.0, Math.max(0.3, conviction));
      reason = adxCrossedUp
        ? `ADX crossed ${p.adxEntryThreshold} (${adxNow.adx.toFixed(1)}), Donchian breakout`
        : `ADX strong+rising (${adxNow.adx.toFixed(1)}), Donchian breakout`;
    }
  } else {
    // Exit logic
    const atrAtEntry = getAtr(candles, idx - barsHeld, p.atrPeriod) ?? atr;
    const trendExhaustion = adxNow.adx < p.adxExitThreshold;
    const stopLossHit = close < entryPrice - p.atrStopMultiplier * atrAtEntry;
    const takeProfitHit = close >= entryPrice + p.atrTakeProfitMultiplier * atrAtEntry;
    const bearishReversal = adxNow.plusDi < adxNow.minusDi && adxNow.adx < adxPrev.adx;

    // Trailing stop
    let highestClose = close;
    for (let i = idx - barsHeld; i <= idx; i++) {
      if (i >= 0 && candles[i].closePrice > highestClose) highestClose = candles[i].closePrice;
    }
    let trailingStopHit = false;
    if (highestClose > entryPrice + 1.0 * atrAtEntry) {
      const trailingStop = highestClose - p.atrStopMultiplier * atrAtEntry;
      trailingStopHit = close < trailingStop;
    }

    if (trendExhaustion) { signal = "SELL"; conviction = 0.8; reason = `ADX exhaustion (${adxNow.adx.toFixed(1)} < ${p.adxExitThreshold})`; }
    else if (stopLossHit) { signal = "SELL"; conviction = 1.0; reason = `stop loss hit (${close.toFixed(0)} < ${(entryPrice - p.atrStopMultiplier * atrAtEntry).toFixed(0)})`; }
    else if (takeProfitHit) { signal = "SELL"; conviction = 0.9; reason = `take profit hit (${close.toFixed(0)} >= ${(entryPrice + p.atrTakeProfitMultiplier * atrAtEntry).toFixed(0)})`; }
    else if (bearishReversal) { signal = "SELL"; conviction = 0.7; reason = `bearish DI reversal, ADX declining`; }
    else if (trailingStopHit) { signal = "SELL"; conviction = 0.85; reason = `trailing stop hit (highest=${highestClose.toFixed(0)})`; }
  }
}

      return {
        strategyId: params.strategyId,
        sleeveId: metadata.sleeveId,
        family: metadata.family,
        market,
        signal,
        conviction,
        decisionTime: context.decisionTime,
        decisionTimeframe: metadata.decisionTimeframe,
        executionTimeframe: metadata.executionTimeframe,
        reason,
        stages: {
          setup_pass: signal !== "HOLD",
          trigger_pass: signal !== "HOLD"
        }
      };
    }
  };
}
