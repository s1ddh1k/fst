// Auto-generated strategy: ADX+MACD Guarded EMA20 Pullback Continuation (1h Gate / 5m Execution)
// Thesis: In 1h up-trend regimes, a shallow pullback that keeps price above the lower Bollinger band and then reclaims EMA20 is more likely continuation than reversal; requiring ADX confirmation and improving MACD histogram prevents entering during weak or choppy conditions and improves walk-forward robustness after costs.
// Generated at: 2026-03-24T15:35:26.872Z

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
  // Minimum ADX(14) on 1h to allow entries; higher values increase trend-strength filtering. (20 - 40)
  // ADX(14) 1h threshold for exit override; below this exits are favored. (15 - 30)
  // Upper normalization cap for ADX in conviction formula. (45 - 75)
  // Minimum MACD histogram slope used to define increasing momentum; lower values are easier to trigger. (0.0001 - 0.01)
  // RSI cap on pullback bar that defines a valid corrective pullback. (35 - 55)
  // EMA period used on execution timeframe for reclaim filter. (10 - 40)
  // BollingerBands period on execution timeframe. (10 - 40)
  // BollingerBands standard deviation multiplier. (1.6 - 2.8)
  // Maximum overshoot tolerance above EMA after reclaim to avoid late entries. (0 - 0.003)
  // ATR period on execution timeframe for stop and take-profit sizing. (10 - 30)
  // ATR multiple used for initial stop-loss. (1 - 4)
  // ATR multiple used for take-profit target. (2 - 8)
  // Minimum gross move target before fees to justify opening a position. (0.0005 - 0.004)
  // Maximum holding time in 5m bars. (12 - 120)
  // Minimum conviction score required for entry and position sizing. (0.45 - 0.8)

export const metadata: GeneratedStrategyMetadata = {
  familyId: "generated:trend_pullback_guarded_ema_macd_1h",
  strategyName: "generated-trend-pullback-guarded-ema-macd-1h",
  title: "ADX+MACD Guarded EMA20 Pullback Continuation (1h Gate / 5m Execution)",
  thesis: "In 1h up-trend regimes, a shallow pullback that keeps price above the lower Bollinger band and then reclaims EMA20 is more likely continuation than reversal; requiring ADX confirmation and improving MACD histogram prevents entering during weak or choppy conditions and improves walk-forward robustness after costs.",
  family: "trend",
  sleeveId: "trend",
  decisionTimeframe: "1h" as StrategyTimeframe,
  executionTimeframe: "5m" as StrategyTimeframe,
  parameterSpecs: [
  {
    "name": "adxTrendMin",
    "description": "Minimum ADX(14) on 1h to allow entries; higher values increase trend-strength filtering.",
    "min": 20,
    "max": 40
  },
  {
    "name": "adxExitMin",
    "description": "ADX(14) 1h threshold for exit override; below this exits are favored.",
    "min": 15,
    "max": 30
  },
  {
    "name": "adxNormMax",
    "description": "Upper normalization cap for ADX in conviction formula.",
    "min": 45,
    "max": 75
  },
  {
    "name": "macdHistSlopeMin",
    "description": "Minimum MACD histogram slope used to define increasing momentum; lower values are easier to trigger.",
    "min": 0.0001,
    "max": 0.01
  },
  {
    "name": "rsiPullbackMax",
    "description": "RSI cap on pullback bar that defines a valid corrective pullback.",
    "min": 35,
    "max": 55
  },
  {
    "name": "emaPeriod",
    "description": "EMA period used on execution timeframe for reclaim filter.",
    "min": 10,
    "max": 40
  },
  {
    "name": "bbPeriod",
    "description": "BollingerBands period on execution timeframe.",
    "min": 10,
    "max": 40
  },
  {
    "name": "bbStdDev",
    "description": "BollingerBands standard deviation multiplier.",
    "min": 1.6,
    "max": 2.8
  },
  {
    "name": "emaReclaimBuffer",
    "description": "Maximum overshoot tolerance above EMA after reclaim to avoid late entries.",
    "min": 0,
    "max": 0.003
  },
  {
    "name": "atrPeriod",
    "description": "ATR period on execution timeframe for stop and take-profit sizing.",
    "min": 10,
    "max": 30
  },
  {
    "name": "atrStopMult",
    "description": "ATR multiple used for initial stop-loss.",
    "min": 1,
    "max": 4
  },
  {
    "name": "atrTakeProfitMult",
    "description": "ATR multiple used for take-profit target.",
    "min": 2,
    "max": 8
  },
  {
    "name": "requiredGrossEdge",
    "description": "Minimum gross move target before fees to justify opening a position.",
    "min": 0.0005,
    "max": 0.004
  },
  {
    "name": "maxHoldBars",
    "description": "Maximum holding time in 5m bars.",
    "min": 12,
    "max": 120
  },
  {
    "name": "minConviction",
    "description": "Minimum conviction score required for entry and position sizing.",
    "min": 0.45,
    "max": 0.8
  }
],
  regimeGate: {"allowedRegimes":["trend_up"]}
};

export function createStrategy(params: {
  strategyId: string;
  parameters: Record<string, number>;
}): Strategy {
  const p = {
    adxTrendMin: params.parameters.adxTrendMin ?? 30,
    adxExitMin: params.parameters.adxExitMin ?? 22.5,
    adxNormMax: params.parameters.adxNormMax ?? 60,
    macdHistSlopeMin: params.parameters.macdHistSlopeMin ?? 0.00505,
    rsiPullbackMax: params.parameters.rsiPullbackMax ?? 45,
    emaPeriod: params.parameters.emaPeriod ?? 25,
    bbPeriod: params.parameters.bbPeriod ?? 25,
    bbStdDev: params.parameters.bbStdDev ?? 2.2,
    emaReclaimBuffer: params.parameters.emaReclaimBuffer ?? 0.0015,
    atrPeriod: params.parameters.atrPeriod ?? 20,
    atrStopMult: params.parameters.atrStopMult ?? 2.5,
    atrTakeProfitMult: params.parameters.atrTakeProfitMult ?? 5,
    requiredGrossEdge: params.parameters.requiredGrossEdge ?? 0.0022500000000000003,
    maxHoldBars: params.parameters.maxHoldBars ?? 66,
    minConviction: params.parameters.minConviction ?? 0.625
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
      // Strategy: Use 1h data for regime and trend qualification, execute on 5m. Enter long only in trend regimes where ADX is high and MACD histogram is rising. A valid setup is: pullback but still above lower BB, then reclaim EMA after being below it. Conviction is a 0..1 score computed from ADX strength, MACD-hist slope, pullback RSI quality, and pullback depth above BB lower band; conviction is used as a risk-size scaler so weaker setups take smaller position size. All thresholds are designed to be re-optimized by walk-forward windows with walk-forward net return (after 0.1% round-turn fee) and max drawdown constraints.
      //
      // Candle fields: .openPrice, .highPrice, .lowPrice, .closePrice, .volume
      // Indicator usage: fn(candles, idx, period) → number|null. Always ?? defaultValue.
      // Must return signal: "BUY", "SELL", or "HOLD"
      // conviction: 0.0 to 1.0
      // ============================================================

      let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
      let conviction = 0;
      let reason = "no signal";

      const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const toNum = (value: number | null | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

signal = "HOLD";
conviction = 0;
reason = "HOLD";

if (idx < 30) {
  reason = "insufficient_history";
} else {
  const close = candles[idx].closePrice;
  const closePrev = candles[idx - 1].closePrice;
  const closeSafe = Math.max(close, 1e-12);
  const h1 = 12;

  const regime1hRaw: any = MarketRegime(candles, idx, h1);
  const regimeName = String((regime1hRaw as any)?.name ?? regime1hRaw ?? "").toLowerCase();
  const trendUp = regimeName === "trend_up";
  const regimeBreak = regimeName !== "trend_up";

  const adx1h = toNum(ADX(candles, idx, h1), 0);
  const adx1hPrev = toNum(ADX(candles, idx - 1, h1), adx1h);

  const macd1h = toNum(MACD(candles, idx, h1), 0);
  const macd1hPrev = toNum(MACD(candles, idx - 1, h1), macd1h);

  const ema = toNum(EMA(candles, idx, p.emaPeriod), close);
  const emaPrev = toNum(EMA(candles, idx - 1, p.emaPeriod), closePrev);

  const rsi = toNum(RSI(candles, idx, 14), 50);
  const rsiPrev = toNum(RSI(candles, idx - 1, 14), rsi);

  const atr = toNum(ATR(candles, idx, p.atrPeriod), 0);
  const atrPrev = toNum(ATR(candles, idx - 1, p.atrPeriod), atr);

  const bbNow = BollingerBands(candles, idx, p.bbPeriod, p.bbStdDev) as any;
  const bbPrev = BollingerBands(candles, idx - 1, p.bbPeriod, p.bbStdDev) as any;

  const bbLowerNow = toNum(
    bbNow?.lower ?? bbNow?.lowerBand ?? (Array.isArray(bbNow) ? (bbNow[2] ?? bbNow[0]) : undefined),
    close
  );
  const bbLowerPrev = toNum(
    bbPrev?.lower ?? bbPrev?.lowerBand ?? (Array.isArray(bbPrev) ? (bbPrev[2] ?? bbPrev[0]) : undefined),
    closePrev
  );
  const bbMidNow = toNum(
    bbNow?.mid ?? bbNow?.middle ?? bbNow?.basis ?? (Array.isArray(bbNow) ? bbNow[1] : undefined),
    close
  );

  const trendGate =
    adx1h >= p.adxTrendMin &&
    macd1h > macd1hPrev &&
    macd1h > 0 &&
    trendUp;

  const pullbackBar =
    closePrev < emaPrev &&
    rsiPrev <= p.rsiPullbackMax &&
    closePrev > bbLowerPrev &&
    rsiPrev >= 20;

  const reclaim =
    close > ema &&
    closePrev <= emaPrev &&
    close <= ema * (1 + p.emaReclaimBuffer);

  const edgeOk = atr * p.atrTakeProfitMult >= closeSafe * Math.max(p.requiredGrossEdge, 0.001);

  const convictionCalc = clamp01(
    0.20 +
      0.30 * clamp01((adx1h - p.adxTrendMin) / ((p.adxNormMax - p.adxTrendMin) || 1)) +
      0.30 * clamp01((macd1h - macd1hPrev) / (p.macdHistSlopeMin || 1)) +
      0.20 * (1 - rsiPrev / 100) +
      0.10 * clamp01((closePrev - bbLowerPrev) / Math.max(2 * atrPrev, 1e-12))
  );

  if (!hasPosition) {
    if (trendGate && pullbackBar && reclaim && edgeOk && convictionCalc >= p.minConviction) {
      signal = "BUY";
      conviction = convictionCalc;
      reason = "adx_macd_gate_pullback_reclaim";
    }
  } else if (entryPrice > 0) {
    const tp = entryPrice * (1 + Math.max(p.atrTakeProfitMult * (atr / entryPrice), p.requiredGrossEdge + 0.001));
    const sl = entryPrice * (1 - p.atrStopMult * (atr / entryPrice));
    const rev1h = (macd1h < 0 && macd1h < macd1hPrev) || adx1h < p.adxExitMin;
    const rev5m = close < ema && close < (bbLowerNow + bbMidNow) / 2;
    const timeExit = Math.floor(barsHeld) >= p.maxHoldBars;
    const unrealizedLoss = Math.max(0, entryPrice - close);
    const feeProtectionExit = unrealizedLoss >= 2 * 0.0005 * entryPrice && close < tp;

    if (close <= sl) {
      signal = "SELL";
      conviction = 1;
      reason = "stop_loss";
    } else if (close >= tp) {
      signal = "SELL";
      conviction = 1;
      reason = "take_profit";
    } else if (rev1h) {
      signal = "SELL";
      conviction = 0.90;
      reason = "reversal_1h";
    } else if (rev5m) {
      signal = "SELL";
      conviction = 0.80;
      reason = "reversal_5m";
    } else if (regimeBreak) {
      signal = "SELL";
      conviction = 0.75;
      reason = "regime_break";
    } else if (timeExit) {
      signal = "SELL";
      conviction = 0.70;
      reason = "max_hold";
    } else if (feeProtectionExit) {
      signal = "SELL";
      conviction = 0.85;
      reason = "loss_fee_protection";
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
