// Auto-generated strategy: Regime-Gated Donchian Breakout vs RSI-Bollinger Reversion (1h->5m)
// Thesis: On KRW spot long-only futures-like spot execution with 0.05% fee per trade, trend regimes reward Donchian breakouts while range or downside regimes reward mean-reversion fades; gating by MarketRegime and ADX keeps each signal family out of anti-alpha regimes, reducing whipsaw and fee drag.
// Generated at: 2026-03-24T15:33:35.314Z

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
  // Donchian channel length for breakout band calculation (20 - 120)
  // Donchian length for breakout invalidation checks (10 - 60)
  // Minimum ADX to allow breakout mode (18 - 40)
  // Minimum ADX increase vs prior bar to confirm trend strength (0.5 - 8)
  // ADX ceiling for mean-reversion mode (12 - 28)
  // RSI period for oversold signal (7 - 21)
  // RSI threshold for reversion entry (20 - 38)
  // Bollinger period (10 - 30)
  // Bollinger standard deviation multiplier (1.5 - 2.8)
  // ATR period for volatility normalized exits (10 - 30)
  // Take-profit ATR multiple in breakout mode (1.2 - 3)
  // Stop-loss ATR multiple in breakout mode (0.8 - 2.2)
  // Take-profit ATR multiple in reversion mode (0.8 - 2.2)
  // Stop-loss ATR multiple in reversion mode (1 - 2.4)
  // Maximum 5m bars to hold breakout entries (24 - 180)
  // Maximum 5m bars to hold reversion entries (12 - 120)
  // Minimum expected edge (as price fraction) above total costs (0.001 - 0.003)
  // Minimum confidence required to open a position (0.35 - 0.8)

export const metadata: GeneratedStrategyMetadata = {
  familyId: "generated:regime-gated-dual-mode-1h",
  strategyName: "generated-regime-gated-dual-mode-1h",
  title: "Regime-Gated Donchian Breakout vs RSI-Bollinger Reversion (1h->5m)",
  thesis: "On KRW spot long-only futures-like spot execution with 0.05% fee per trade, trend regimes reward Donchian breakouts while range or downside regimes reward mean-reversion fades; gating by MarketRegime and ADX keeps each signal family out of anti-alpha regimes, reducing whipsaw and fee drag.",
  family: "trend",
  sleeveId: "reversion",
  decisionTimeframe: "1h" as StrategyTimeframe,
  executionTimeframe: "5m" as StrategyTimeframe,
  parameterSpecs: [
  {
    "name": "donchianLen",
    "description": "Donchian channel length for breakout band calculation",
    "min": 20,
    "max": 120
  },
  {
    "name": "donchianExitLen",
    "description": "Donchian length for breakout invalidation checks",
    "min": 10,
    "max": 60
  },
  {
    "name": "adxTrendMin",
    "description": "Minimum ADX to allow breakout mode",
    "min": 18,
    "max": 40
  },
  {
    "name": "adxRisingMin",
    "description": "Minimum ADX increase vs prior bar to confirm trend strength",
    "min": 0.5,
    "max": 8
  },
  {
    "name": "adxRangeMax",
    "description": "ADX ceiling for mean-reversion mode",
    "min": 12,
    "max": 28
  },
  {
    "name": "rsiLen",
    "description": "RSI period for oversold signal",
    "min": 7,
    "max": 21
  },
  {
    "name": "rsiOversold",
    "description": "RSI threshold for reversion entry",
    "min": 20,
    "max": 38
  },
  {
    "name": "bbLen",
    "description": "Bollinger period",
    "min": 10,
    "max": 30
  },
  {
    "name": "bbStd",
    "description": "Bollinger standard deviation multiplier",
    "min": 1.5,
    "max": 2.8
  },
  {
    "name": "atrLen",
    "description": "ATR period for volatility normalized exits",
    "min": 10,
    "max": 30
  },
  {
    "name": "tpAtrBreakout",
    "description": "Take-profit ATR multiple in breakout mode",
    "min": 1.2,
    "max": 3
  },
  {
    "name": "slAtrBreakout",
    "description": "Stop-loss ATR multiple in breakout mode",
    "min": 0.8,
    "max": 2.2
  },
  {
    "name": "tpAtrRevert",
    "description": "Take-profit ATR multiple in reversion mode",
    "min": 0.8,
    "max": 2.2
  },
  {
    "name": "slAtrRevert",
    "description": "Stop-loss ATR multiple in reversion mode",
    "min": 1,
    "max": 2.4
  },
  {
    "name": "maxHoldBarsBreakout",
    "description": "Maximum 5m bars to hold breakout entries",
    "min": 24,
    "max": 180
  },
  {
    "name": "maxHoldBarsRevert",
    "description": "Maximum 5m bars to hold reversion entries",
    "min": 12,
    "max": 120
  },
  {
    "name": "feeBuffer",
    "description": "Minimum expected edge (as price fraction) above total costs",
    "min": 0.001,
    "max": 0.003
  },
  {
    "name": "minConviction",
    "description": "Minimum confidence required to open a position",
    "min": 0.35,
    "max": 0.8
  }
],
  regimeGate: {"allowedRegimes":["trend_up","range","trend_down"]}
};

export function createStrategy(params: {
  strategyId: string;
  parameters: Record<string, number>;
}): Strategy {
  const p = {
    donchianLen: params.parameters.donchianLen ?? 70,
    donchianExitLen: params.parameters.donchianExitLen ?? 35,
    adxTrendMin: params.parameters.adxTrendMin ?? 29,
    adxRisingMin: params.parameters.adxRisingMin ?? 4.25,
    adxRangeMax: params.parameters.adxRangeMax ?? 20,
    rsiLen: params.parameters.rsiLen ?? 14,
    rsiOversold: params.parameters.rsiOversold ?? 29,
    bbLen: params.parameters.bbLen ?? 20,
    bbStd: params.parameters.bbStd ?? 2.15,
    atrLen: params.parameters.atrLen ?? 20,
    tpAtrBreakout: params.parameters.tpAtrBreakout ?? 2.1,
    slAtrBreakout: params.parameters.slAtrBreakout ?? 1.5,
    tpAtrRevert: params.parameters.tpAtrRevert ?? 1.5,
    slAtrRevert: params.parameters.slAtrRevert ?? 1.7,
    maxHoldBarsBreakout: params.parameters.maxHoldBarsBreakout ?? 102,
    maxHoldBarsRevert: params.parameters.maxHoldBarsRevert ?? 66,
    feeBuffer: params.parameters.feeBuffer ?? 0.002,
    minConviction: params.parameters.minConviction ?? 0.575
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
      // Strategy: Use 1h bars for regime/decision and submit at most one 5m execution per detected setup. If regime is trend_up and ADX is above threshold and rising, run breakout branch: buy only on Donchian breakout with momentum confirmation. If regime is range or trend_down and ADX is below trend-structure threshold, run reversion branch: buy only on oversold pullback inside lower Bollinger zone. Conviction is a bounded 0-1 score built from regime confidence, indicator signal strength, and expected edge over costs. Skip all entries when confidence < minConviction.
      //
      // Candle fields: .openPrice, .highPrice, .lowPrice, .closePrice, .volume
      // Indicator usage: fn(candles, idx, period) → number|null. Always ?? defaultValue.
      // Must return signal: "BUY", "SELL", or "HOLD"
      // conviction: 0.0 to 1.0
      // ============================================================

      let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
      let conviction = 0;
      let reason = "no signal";

      const tiny = 1e-12;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const feeThreshold = 2 * 0.0005 + 0.0003;

signal = "HOLD";
conviction = 0;
reason = "HOLD";

if (idx < 30) {
  reason = "insufficient_history";
} else {
  const close = candles[idx].closePrice;
  const closeSafe = Math.max(close, tiny);
  const prevClose = idx > 0 ? candles[idx - 1].closePrice : close;

  const regime: any = MarketRegime(candles, idx, 12);
  const regimeName = regime?.name ?? "range";
  const regimeStrength = clamp01(typeof regime?.strength === "number" ? regime.strength : 0);

  const adx = ADX(candles, idx, 14) ?? 0;
  const adxPrev = idx > 0 ? (ADX(candles, idx - 1, 14) ?? adx) : adx;
  const adxDelta = adx - adxPrev;

  const atr = Math.max(ATR(candles, idx, p.atrLen) ?? 0, tiny);
  const don = DonchianChannel(candles, idx, p.donchianLen) as any;
  const donExit = DonchianChannel(candles, idx, p.donchianExitLen) as any;
  const bb = BollingerBands(candles, idx, p.bbLen, p.bbStd) as any;
  const sma = SMA(candles, idx, p.bbLen) ?? close;
  const rsi = RSI(candles, idx, p.rsiLen) ?? 50;

  if (!hasPosition) {
    if (regimeName === "trend_up" && adx >= p.adxTrendMin && adxDelta >= p.adxRisingMin) {
      const upper = don?.upper ?? close;
      const breakoutStrength = (close - upper) / atr;
      const trendConv = clamp01(
        0.30 +
          0.40 * Math.min(1, (adx - p.adxTrendMin) / 20) +
          0.20 * Math.min(1, adxDelta / (p.adxRisingMin > 0 ? p.adxRisingMin : 1)) +
          0.10 * regimeStrength +
          0.20 * Math.min(1, breakoutStrength / 1.2)
      );
      const expectedEdge = Math.max(0, (close - upper) / closeSafe);

      if (
        close > upper &&
        expectedEdge >= p.feeBuffer &&
        expectedEdge > feeThreshold &&
        trendConv >= p.minConviction
      ) {
        signal = "BUY";
        conviction = trendConv;
        reason = "breakout_entry_trend_up";
      }
    } else if (
      (regimeName === "range" || regimeName === "trend_down") &&
      adx <= p.adxRangeMax
    ) {
      const lower = bb?.lower ?? close;
      const depth = (lower - close) / atr;
      const reversionConv = clamp01(
        0.35 +
          0.35 * Math.min(1, (p.rsiOversold - rsi + 5) / (p.rsiOversold > 0 ? p.rsiOversold : 1)) +
          0.15 * Math.min(1, depth / 1.5) +
          0.10 * regimeStrength
      );
      const expectedEdge = Math.max(0, (lower - close) / closeSafe);

      if (
        close < lower &&
        rsi <= p.rsiOversold &&
        close < sma &&
        close > prevClose &&
        expectedEdge >= p.feeBuffer &&
        expectedEdge > feeThreshold &&
        reversionConv >= p.minConviction
      ) {
        signal = "BUY";
        conviction = reversionConv;
        reason = "reversion_entry_range_or_down";
      }
    }
  } else {
    const heldBars = Math.max(0, Math.floor(barsHeld));
    const entryIdx = Math.max(0, idx - heldBars);
    const entryAtr = Math.max(ATR(candles, entryIdx, p.atrLen) ?? atr, tiny);

    const entryRegime: any = MarketRegime(candles, entryIdx, 12);
    const entryDon = DonchianChannel(candles, entryIdx, p.donchianLen) as any;
    const entryBb = BollingerBands(candles, entryIdx, p.bbLen, p.bbStd) as any;
    const entryClose = candles[entryIdx].closePrice;
    const entryUpper = entryDon?.upper ?? entryClose;
    const entryLower = entryBb?.lower ?? entryClose;

    let mode: "breakout" | "reversion" = regimeName === "trend_up" ? "breakout" : "reversion";
    if (entryClose > entryUpper) {
      mode = "breakout";
    } else if (entryClose < entryLower) {
      mode = "reversion";
    } else if ((entryRegime?.name ?? regimeName) === "trend_up") {
      mode = "breakout";
    } else if ((entryRegime?.name ?? regimeName) === "range" || (entryRegime?.name ?? regimeName) === "trend_down") {
      mode = "reversion";
    }

    if (mode === "breakout") {
      const tp = entryPrice + p.tpAtrBreakout * entryAtr;
      const sl = entryPrice - p.slAtrBreakout * entryAtr;

      if (close >= tp) {
        signal = "SELL";
        conviction = 0.93;
        reason = "breakout_take_profit";
      } else if (close <= sl) {
        signal = "SELL";
        conviction = 1.0;
        reason = "breakout_hard_stop";
      } else if (
        adx < p.adxTrendMin ||
        adxDelta <= 0 ||
        close < (donExit?.middle ?? close)
      ) {
        signal = "SELL";
        conviction = 0.8;
        reason = "breakout_trend_weakening";
      } else if (barsHeld >= p.maxHoldBarsBreakout) {
        signal = "SELL";
        conviction = 0.72;
        reason = "breakout_time_stop";
      }
    } else {
      const tp = entryPrice + p.tpAtrRevert * entryAtr;
      const sl = entryPrice - p.slAtrRevert * entryAtr;

      if (close >= tp) {
        signal = "SELL";
        conviction = 0.92;
        reason = "reversion_take_profit";
      } else if (close <= sl) {
        signal = "SELL";
        conviction = 1.0;
        reason = "reversion_hard_stop";
      } else if (
        close >= (bb?.middle ?? close) &&
        rsi >= 52 &&
        close > prevClose
      ) {
        signal = "SELL";
        conviction = 0.86;
        reason = "reversion_mean_reversion_target";
      } else if (regimeName === "trend_up" && adx > p.adxTrendMin) {
        signal = "SELL";
        conviction = 0.78;
        reason = "reversion_regime_flip";
      } else if (barsHeld >= p.maxHoldBarsRevert) {
        signal = "SELL";
        conviction = 0.7;
        reason = "reversion_time_stop";
      }
    }
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
