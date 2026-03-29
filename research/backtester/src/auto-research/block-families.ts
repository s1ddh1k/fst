import type { Strategy, StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import type { ScoredStrategy } from "../../../strategies/src/types.js";
import type { ResearchParameterSpec, StrategyFamilyDefinition } from "./types.js";
import { adaptScoredStrategy } from "../multi-strategy/index.js";
import {
  createMicroBreakoutStrategy,
  createLeaderPullbackStateMachineMultiStrategy,
  createRelativeBreakoutRotationMultiStrategy,
  createRelativeMomentumPullbackMultiStrategy,
  createResidualReversionMultiStrategy,
  createRelativeStrengthRotationStrategy,
  createBollingerMeanReversionMultiStrategy
} from "../multi-strategy/index.js";
import {
  createEmaCrossoverStrategy,
  createDonchianBreakoutStrategy,
  createSimpleRsiReversionStrategy,
  createSimpleBbReversionStrategy,
  createMomentumRotationStrategy,
  createOversoldBounceScalpStrategy,
  createCrashDipBuyStrategy,
  createVolumeBreakoutRiderStrategy,
  createVolumeExhaustionBounceStrategy,
  createBbSqueezeScalpStrategy,
  createRelativeStrengthBounceStrategy,
  createTrendAccelerationStrategy,
  createVolumeExhaustionBounce5mStrategy,
  createOversoldScalp5mStrategy,
  createMomentumBurst5mStrategy,
  createObvAccumulationBounceStrategy,
  createConsecutiveRedBounceStrategy,
  createObvAccumulationBounce5mStrategy,
  createConsecutiveRedBounce5mStrategy,
  createVolumeExhaustionBounce15mStrategy,
  createOversoldBounceScalp15mStrategy,
  createCrashDipBuy15mStrategy,
  createObvAccumulationBounce15mStrategy,
  createConsecutiveRedBounce15mStrategy
} from "../../../strategies/src/simple-strategies.js";

// ---------------------------------------------------------------------------
// Parameter utilities
// ---------------------------------------------------------------------------

function clampParams(
  raw: Record<string, number>,
  specs: ResearchParameterSpec[]
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const spec of specs) {
    const value = raw[spec.name];
    if (value === undefined || !Number.isFinite(value)) {
      result[spec.name] = (spec.min + spec.max) / 2;
      continue;
    }
    const clamped = Math.max(spec.min, Math.min(spec.max, value));
    result[spec.name] = spec.name.includes("Pct") || spec.name.includes("Mult") || spec.name.includes("mult") || spec.name.includes("Ratio") || spec.name.includes("ratio") || spec.name.includes("Floor") || spec.name.includes("floor") || spec.name.includes("Width") || spec.name.includes("Multiplier")
      ? clamped
      : Math.round(clamped);
  }
  return result;
}

// Generated strategy module paths (dynamic imports)
const GENERATED_STRATEGY_MODULES: Record<string, string> = {
  "block:simple-stochastic-rsi-reversion-5m":  "../generated-strategies/generated-block-stochastic-rsi-reversion-5m.js",
  "block:simple-stochastic-rsi-reversion-1h":  "../generated-strategies/generated-block-stochastic-rsi-reversion-1h.js",
  "block:simple-macd-histogram-reversal-1h":   "../generated-strategies/generated-block-macd-histogram-reversal-1h.js",
  "block:simple-ema-macd-trend-15m":           "../generated-strategies/generated-block-ema-macd-trend-15m.js",
  "block:simple-cci-volume-reversion-5m":      "../generated-strategies/generated-block-cci-volume-reversion-5m.js",
  "block:simple-cci-volume-reversion-1h":      "../generated-strategies/generated-block-cci-volume-reversion-1h.js",
};

const REGIME_GATE_TREND_UP_SPECS: ResearchParameterSpec[] = [
  { name: "gateMinRiskOnScore", description: "Regime gate risk-on floor.", min: -0.15, max: 0.25 },
  { name: "gateMinTrendScore", description: "Regime gate trend-score floor.", min: -0.05, max: 0.2 },
  { name: "gateMinAboveTrendRatio", description: "Regime gate above-trend floor.", min: 0.35, max: 0.8 },
  { name: "gateMinLiquidityScore", description: "Regime gate liquidity floor.", min: 0.01, max: 0.25 }
];

const REGIME_GATE_VOLATILE_SPECS: ResearchParameterSpec[] = [
  { name: "gateMinRiskOnScore", description: "Regime gate risk-on floor.", min: -0.15, max: 0.2 },
  { name: "gateMinLiquidityScore", description: "Regime gate liquidity floor.", min: 0.01, max: 0.25 },
  { name: "gateMinVolatility", description: "Regime gate volatility floor.", min: 0.001, max: 0.04 }
];

const REGIME_GATE_RANGE_DOWN_SPECS: ResearchParameterSpec[] = [
  { name: "gateMaxRiskOnScore", description: "Regime gate risk-on ceiling.", min: -0.2, max: 0.35 },
  { name: "gateMaxTrendScore", description: "Regime gate trend-score ceiling.", min: -0.2, max: 0.3 },
  { name: "gateMaxVolatility", description: "Regime gate volatility ceiling.", min: 0.015, max: 0.08 }
];

// Weekly-like BB on 1h candles: wide BB to simulate weekly oversold conditions.
// Key insight: real weekly BB 20-period = 20 weeks = 3360 hours. On 1h candles,
// use wide window (336-504 bars = 14-21 days) with HIGH multiplier (2.5-3.0)
// and NEGATIVE entryPercentB to only catch deep oversold extremes.
const BB_MEAN_REVERSION_WEEKLY_SPECS: ResearchParameterSpec[] = [
  { name: "bbWindow", description: "BB SMA window in 1h bars (336=14d, 504=21d).", min: 336, max: 504 },
  { name: "bbMultiplier", description: "BB std multiplier (high to widen band).", min: 2.5, max: 3.5 },
  { name: "rsiPeriod", description: "RSI period in 1h bars (long for weekly-like).", min: 72, max: 168 },
  { name: "entryRsiThreshold", description: "RSI oversold threshold required for entry.", min: 18, max: 40 },
  { name: "reclaimLookbackBars", description: "Bars allowed between the oversold touch and reclaim entry.", min: 4, max: 48 },
  { name: "reclaimPercentBThreshold", description: "Current %B required to confirm reclaim off the lower band.", min: 0.02, max: 0.35 },
  { name: "reclaimMinCloseBouncePct", description: "Minimum close bounce required versus the recent touch close.", min: 0.001, max: 0.03 },
  { name: "reclaimBandWidthFactor", description: "Minimum reclaim bounce as a fraction of Bollinger width.", min: 0.02, max: 0.35 },
  { name: "deepTouchEntryPercentB", description: "Current-bar deep touch threshold that allows immediate entry before reclaim.", min: -0.25, max: -0.02 },
  { name: "deepTouchRsiThreshold", description: "RSI ceiling required for immediate deep-touch entries.", min: 10, max: 32 },
  { name: "exitRsi", description: "RSI exit target (mean reversion).", min: 45, max: 60 },
  { name: "stopLossPct", description: "Stop loss percentage (wide for weekly).", min: 0.20, max: 0.35 },
  { name: "maxHoldBars", description: "Max hold bars (long for weekly).", min: 336, max: 1008 },
  { name: "entryPercentB", description: "BB %B entry (negative = below lower band).", min: -0.2, max: 0.0 },
  { name: "minBandWidth", description: "Minimum BB width to avoid squeezed ranges.", min: 0.01, max: 0.18 },
  { name: "trendUpExitRsiOffset", description: "RSI exit offset in trend_up regime.", min: 2, max: 18 },
  { name: "trendDownExitRsiOffset", description: "RSI exit offset in trend_down regime.", min: -20, max: -2 },
  { name: "rangeExitRsiOffset", description: "RSI exit offset in range regime.", min: -12, max: 4 },
  { name: "trendUpExitBandFraction", description: "Upper-band zone fraction for trend_up exits.", min: 0.1, max: 0.7 },
  { name: "trendDownExitBandFraction", description: "Lower-to-middle band fraction used for trend_down dead-cat exits.", min: 0.05, max: 0.7 },
  { name: "volatileExitBandFraction", description: "Lower-to-middle band fraction used for volatile rebound exits.", min: 0.1, max: 0.9 },
  { name: "profitTakePnlThreshold", description: "Minimum profit floor for early partial exit.", min: 0.008, max: 0.12 },
  { name: "profitTakeBandWidthFactor", description: "Profit target multiplier applied to normalized BB width.", min: 0.25, max: 1.8 },
  { name: "trendDownProfitTargetScale", description: "Scale factor applied to width-based profit targets in trend_down.", min: 0.25, max: 1.0 },
  { name: "volatileProfitTargetScale", description: "Scale factor applied to width-based profit targets in volatile regimes.", min: 0.3, max: 1.1 },
  { name: "cooldownBarsAfterLoss", description: "Bars to wait after a losing exit before re-entering the same market.", min: 8, max: 168 },
  { name: "minBarsBetweenEntries", description: "Minimum bars between same-market entries.", min: 4, max: 96 },
  { name: "profitTakeRsiFraction", description: "Fraction of exit RSI needed for profit-taking.", min: 0.65, max: 1.0 },
  { name: "entryBenchmarkLeadWeight", description: "How much benchmark tailwind lifts entry conviction.", min: 0.0, max: 0.35 },
  { name: "entryBenchmarkLeadMinScore", description: "Minimum benchmark lead score required to allow entry.", min: 0.0, max: 0.85 },
  { name: "softExitScoreThreshold", description: "Weighted rebound-exhaustion score needed for an early soft exit.", min: 0.45, max: 0.85 },
  { name: "softExitMinPnl", description: "Minimum pnl needed before soft-exit scoring can arm.", min: 0.004, max: 0.12 },
  { name: "softExitMinBandFraction", description: "Minimum lower-to-middle band recovery fraction before soft-exit scoring can arm.", min: 0.1, max: 1.0 },
  { name: "exitVolumeFadeWeight", description: "Weight for fading rebound participation at exit.", min: 0.0, max: 0.45 },
  { name: "exitReversalWeight", description: "Weight for reversal-candle exhaustion at exit.", min: 0.0, max: 0.55 },
  { name: "exitMomentumDecayWeight", description: "Weight for RSI and MACD decay at exit.", min: 0.0, max: 0.45 },
  { name: "exitBenchmarkWeaknessWeight", description: "Weight for benchmark weakness and relative underperformance at exit.", min: 0.0, max: 0.35 },
  { name: "exitRelativeFragilityWeight", description: "Weight for alt-specific weakness versus benchmark/composite/cohort at exit.", min: 0.0, max: 0.45 },
  { name: "exitTimeDecayWeight", description: "Weight for time-decay pressure as the trade ages.", min: 0.0, max: 0.35 }
];

// Daily-like BB on 1h candles: larger window + higher multiplier for selectivity
const BB_MEAN_REVERSION_DAILY_SPECS: ResearchParameterSpec[] = [
  { name: "bbWindow", description: "BB SMA window in 1h bars (48=2d, 72=3d).", min: 48, max: 120 },
  { name: "bbMultiplier", description: "BB std multiplier (higher = fewer signals).", min: 2.0, max: 3.0 },
  { name: "rsiPeriod", description: "RSI period in 1h bars.", min: 24, max: 72 },
  { name: "entryRsiThreshold", description: "RSI oversold threshold required for entry.", min: 20, max: 42 },
  { name: "reclaimLookbackBars", description: "Bars allowed between the oversold touch and reclaim entry.", min: 2, max: 16 },
  { name: "reclaimPercentBThreshold", description: "Current %B required to confirm reclaim off the lower band.", min: 0.04, max: 0.4 },
  { name: "reclaimMinCloseBouncePct", description: "Minimum close bounce required versus the recent touch close.", min: 0.001, max: 0.02 },
  { name: "reclaimBandWidthFactor", description: "Minimum reclaim bounce as a fraction of Bollinger width.", min: 0.02, max: 0.45 },
  { name: "deepTouchEntryPercentB", description: "Current-bar deep touch threshold that allows immediate entry before reclaim.", min: -0.18, max: -0.02 },
  { name: "deepTouchRsiThreshold", description: "RSI ceiling required for immediate deep-touch entries.", min: 10, max: 32 },
  { name: "exitRsi", description: "RSI exit target (lower for faster exit).", min: 38, max: 50 },
  { name: "stopLossPct", description: "Stop loss percentage.", min: 0.10, max: 0.25 },
  { name: "maxHoldBars", description: "Max hold bars.", min: 48, max: 240 },
  { name: "entryPercentB", description: "BB %B entry (negative = below lower band).", min: -0.15, max: 0.0 },
  { name: "minBandWidth", description: "Minimum BB width to avoid squeezed ranges.", min: 0.005, max: 0.12 },
  { name: "trendUpExitRsiOffset", description: "RSI exit offset in trend_up regime.", min: 2, max: 16 },
  { name: "trendDownExitRsiOffset", description: "RSI exit offset in trend_down regime.", min: -16, max: -2 },
  { name: "rangeExitRsiOffset", description: "RSI exit offset in range regime.", min: -10, max: 4 },
  { name: "trendUpExitBandFraction", description: "Upper-band zone fraction for trend_up exits.", min: 0.1, max: 0.6 },
  { name: "trendDownExitBandFraction", description: "Lower-to-middle band fraction used for trend_down dead-cat exits.", min: 0.05, max: 0.65 },
  { name: "volatileExitBandFraction", description: "Lower-to-middle band fraction used for volatile rebound exits.", min: 0.1, max: 0.8 },
  { name: "profitTakePnlThreshold", description: "Minimum profit floor for early partial exit.", min: 0.004, max: 0.06 },
  { name: "profitTakeBandWidthFactor", description: "Profit target multiplier applied to normalized BB width.", min: 0.15, max: 1.2 },
  { name: "trendDownProfitTargetScale", description: "Scale factor applied to width-based profit targets in trend_down.", min: 0.25, max: 0.9 },
  { name: "volatileProfitTargetScale", description: "Scale factor applied to width-based profit targets in volatile regimes.", min: 0.3, max: 1.0 },
  { name: "cooldownBarsAfterLoss", description: "Bars to wait after a losing exit before re-entering the same market.", min: 4, max: 72 },
  { name: "minBarsBetweenEntries", description: "Minimum bars between same-market entries.", min: 2, max: 48 },
  { name: "profitTakeRsiFraction", description: "Fraction of exit RSI needed for profit-taking.", min: 0.65, max: 1.0 },
  { name: "entryBenchmarkLeadWeight", description: "How much benchmark tailwind lifts entry conviction.", min: 0.0, max: 0.45 },
  { name: "entryBenchmarkLeadMinScore", description: "Minimum benchmark lead score required to allow entry.", min: 0.0, max: 0.85 },
  { name: "softExitScoreThreshold", description: "Weighted rebound-exhaustion score needed for an early soft exit.", min: 0.35, max: 0.8 },
  { name: "softExitMinPnl", description: "Minimum pnl needed before soft-exit scoring can arm.", min: 0.001, max: 0.06 },
  { name: "softExitMinBandFraction", description: "Minimum lower-to-middle band recovery fraction before soft-exit scoring can arm.", min: 0.08, max: 0.9 },
  { name: "exitVolumeFadeWeight", description: "Weight for fading rebound participation at exit.", min: 0.0, max: 0.5 },
  { name: "exitReversalWeight", description: "Weight for reversal-candle exhaustion at exit.", min: 0.0, max: 0.6 },
  { name: "exitMomentumDecayWeight", description: "Weight for RSI and MACD decay at exit.", min: 0.0, max: 0.5 },
  { name: "exitBenchmarkWeaknessWeight", description: "Weight for benchmark weakness and relative underperformance at exit.", min: 0.0, max: 0.4 },
  { name: "exitRelativeFragilityWeight", description: "Weight for alt-specific weakness versus benchmark/composite/cohort at exit.", min: 0.0, max: 0.5 },
  { name: "exitTimeDecayWeight", description: "Weight for time-decay pressure as the trade ages.", min: 0.0, max: 0.4 }
];

const BB_MEAN_REVERSION_HOURLY_SPECS: ResearchParameterSpec[] = [
  { name: "bbWindow", description: "BB SMA window in 1h bars (12=12h, 36=1.5d).", min: 12, max: 36 },
  { name: "bbMultiplier", description: "BB std multiplier for hourly oversold detection.", min: 1.6, max: 2.6 },
  { name: "rsiPeriod", description: "RSI period in 1h bars (short for hourly-like).", min: 8, max: 24 },
  { name: "entryRsiThreshold", description: "RSI oversold threshold required for entry.", min: 20, max: 40 },
  { name: "reclaimLookbackBars", description: "Bars allowed between the oversold touch and reclaim entry.", min: 1, max: 8 },
  { name: "reclaimPercentBThreshold", description: "Current %B required to confirm reclaim off the lower band.", min: 0.06, max: 0.5 },
  { name: "reclaimMinCloseBouncePct", description: "Minimum close bounce required versus the recent touch close.", min: 0.0005, max: 0.015 },
  { name: "reclaimBandWidthFactor", description: "Minimum reclaim bounce as a fraction of Bollinger width.", min: 0.02, max: 0.6 },
  { name: "deepTouchEntryPercentB", description: "Current-bar deep touch threshold that allows immediate entry before reclaim.", min: -0.12, max: -0.005 },
  { name: "deepTouchRsiThreshold", description: "RSI ceiling required for immediate deep-touch entries.", min: 8, max: 28 },
  { name: "exitRsi", description: "RSI exit target for quick hourly reversions.", min: 34, max: 46 },
  { name: "stopLossPct", description: "Stop loss percentage for hourly-like reversion.", min: 0.04, max: 0.16 },
  { name: "maxHoldBars", description: "Max hold bars for hourly-like reversion.", min: 12, max: 72 },
  { name: "entryPercentB", description: "BB %B entry (negative = below lower band).", min: -0.08, max: 0.02 },
  { name: "minBandWidth", description: "Minimum BB width to avoid squeezed ranges.", min: 0.003, max: 0.08 },
  { name: "trendUpExitRsiOffset", description: "RSI exit offset in trend_up regime.", min: 2, max: 12 },
  { name: "trendDownExitRsiOffset", description: "RSI exit offset in trend_down regime.", min: -12, max: -2 },
  { name: "rangeExitRsiOffset", description: "RSI exit offset in range regime.", min: -8, max: 2 },
  { name: "trendUpExitBandFraction", description: "Upper-band zone fraction for trend_up exits.", min: 0.05, max: 0.45 },
  { name: "trendDownExitBandFraction", description: "Lower-to-middle band fraction used for trend_down dead-cat exits.", min: 0.05, max: 0.55 },
  { name: "volatileExitBandFraction", description: "Lower-to-middle band fraction used for volatile rebound exits.", min: 0.08, max: 0.6 },
  { name: "profitTakePnlThreshold", description: "Minimum profit floor for early partial exit.", min: 0.002, max: 0.02 },
  { name: "profitTakeBandWidthFactor", description: "Profit target multiplier applied to normalized BB width.", min: 0.08, max: 0.7 },
  { name: "trendDownProfitTargetScale", description: "Scale factor applied to width-based profit targets in trend_down.", min: 0.2, max: 0.8 },
  { name: "volatileProfitTargetScale", description: "Scale factor applied to width-based profit targets in volatile regimes.", min: 0.25, max: 0.9 },
  { name: "cooldownBarsAfterLoss", description: "Bars to wait after a losing exit before re-entering the same market.", min: 2, max: 24 },
  { name: "minBarsBetweenEntries", description: "Minimum bars between same-market entries.", min: 1, max: 16 },
  { name: "profitTakeRsiFraction", description: "Fraction of exit RSI needed for profit-taking.", min: 0.6, max: 0.95 },
  { name: "entryBenchmarkLeadWeight", description: "How much benchmark tailwind lifts entry conviction.", min: 0.0, max: 0.55 },
  { name: "entryBenchmarkLeadMinScore", description: "Minimum benchmark lead score required to allow entry.", min: 0.0, max: 0.9 },
  { name: "softExitScoreThreshold", description: "Weighted rebound-exhaustion score needed for an early soft exit.", min: 0.3, max: 0.75 },
  { name: "softExitMinPnl", description: "Minimum pnl needed before soft-exit scoring can arm.", min: 0.0005, max: 0.02 },
  { name: "softExitMinBandFraction", description: "Minimum lower-to-middle band recovery fraction before soft-exit scoring can arm.", min: 0.05, max: 0.75 },
  { name: "exitVolumeFadeWeight", description: "Weight for fading rebound participation at exit.", min: 0.0, max: 0.55 },
  { name: "exitReversalWeight", description: "Weight for reversal-candle exhaustion at exit.", min: 0.0, max: 0.65 },
  { name: "exitMomentumDecayWeight", description: "Weight for RSI and MACD decay at exit.", min: 0.0, max: 0.55 },
  { name: "exitBenchmarkWeaknessWeight", description: "Weight for benchmark weakness and relative underperformance at exit.", min: 0.0, max: 0.45 },
  { name: "exitRelativeFragilityWeight", description: "Weight for alt-specific weakness versus benchmark/composite/cohort at exit.", min: 0.0, max: 0.6 },
  { name: "exitTimeDecayWeight", description: "Weight for time-decay pressure as the trade ages.", min: 0.0, max: 0.45 }
];

function createBbReversionFactory(
  familyId: string,
  strategySuffix: string,
  requireRsiConfirmation: boolean
): (candidateId: string, params: Record<string, number>) => Promise<import("../../../../packages/shared/src/index.js").Strategy> {
  return async (candidateId, params) => {
    const family = BLOCK_FAMILY_CATALOG.find(f => f.familyId === familyId)!;
    const p = clampParams(params, family.parameterSpecs);
    return createBollingerMeanReversionMultiStrategy({
      strategyId: `${candidateId}-${strategySuffix}`,
      bbWindow: p.bbWindow,
      bbMultiplier: p.bbMultiplier,
      rsiPeriod: p.rsiPeriod,
      entryRsiThreshold: p.entryRsiThreshold,
      requireRsiConfirmation,
      requireReclaimConfirmation: true,
      reclaimLookbackBars: p.reclaimLookbackBars,
      reclaimPercentBThreshold: p.reclaimPercentBThreshold,
      reclaimMinCloseBouncePct: p.reclaimMinCloseBouncePct,
      reclaimBandWidthFactor: p.reclaimBandWidthFactor,
      deepTouchEntryPercentB: p.deepTouchEntryPercentB,
      deepTouchRsiThreshold: p.deepTouchRsiThreshold,
      exitRsi: p.exitRsi,
      stopLossPct: p.stopLossPct,
      maxHoldBars: p.maxHoldBars,
      entryPercentB: p.entryPercentB,
      minBandWidth: p.minBandWidth,
      trendUpExitRsiOffset: p.trendUpExitRsiOffset,
      trendDownExitRsiOffset: p.trendDownExitRsiOffset,
      rangeExitRsiOffset: p.rangeExitRsiOffset,
      trendUpExitBandFraction: p.trendUpExitBandFraction,
      trendDownExitBandFraction: p.trendDownExitBandFraction,
      volatileExitBandFraction: p.volatileExitBandFraction,
      profitTakePnlThreshold: p.profitTakePnlThreshold,
      profitTakeBandWidthFactor: p.profitTakeBandWidthFactor,
      trendDownProfitTargetScale: p.trendDownProfitTargetScale,
      volatileProfitTargetScale: p.volatileProfitTargetScale,
      profitTakeRsiFraction: p.profitTakeRsiFraction,
      entryBenchmarkLeadWeight: p.entryBenchmarkLeadWeight,
      entryBenchmarkLeadMinScore: p.entryBenchmarkLeadMinScore,
      softExitScoreThreshold: p.softExitScoreThreshold,
      softExitMinPnl: p.softExitMinPnl,
      softExitMinBandFraction: p.softExitMinBandFraction,
      exitVolumeFadeWeight: p.exitVolumeFadeWeight,
      exitReversalWeight: p.exitReversalWeight,
      exitMomentumDecayWeight: p.exitMomentumDecayWeight,
      exitBenchmarkWeaknessWeight: p.exitBenchmarkWeaknessWeight,
      exitRelativeFragilityWeight: p.exitRelativeFragilityWeight,
      exitTimeDecayWeight: p.exitTimeDecayWeight
    });
  };
}

const BLOCK_FAMILY_CATALOG: StrategyFamilyDefinition[] = [
  {
    familyId: "block:rotation-15m-trend-up",
    strategyName: "block:rotation-15m-trend-up",
    sleeveId: "trend",
    family: "trend",
    title: "15m Rotation Block (trend_up)",
    thesis: "Relative strength rotation on 15m decision, 5m execution, gated to trend-up regime.",
    timeframe: "15m",
    requiredData: ["15m", "5m"],
    parameterSpecs: [
      { name: "rebalanceBars", description: "Rebalance cadence in 15m bars.", min: 4, max: 8 },
      { name: "entryFloor", description: "Rotation entry floor.", min: 0.72, max: 0.92 },
      { name: "exitFloor", description: "Rotation exit floor.", min: 0.42, max: 0.72 },
      { name: "switchGap", description: "Switch threshold.", min: 0.06, max: 0.18 },
      { name: "minAboveTrendRatio", description: "Breadth above-trend floor.", min: 0.55, max: 0.86 },
      { name: "minLiquidityScore", description: "Liquidity floor.", min: 0.02, max: 0.25 },
      { name: "minCompositeTrend", description: "Composite trend floor.", min: -0.05, max: 0.18 },
      ...REGIME_GATE_TREND_UP_SPECS
    ],
    guardrails: [
      "Long-only, point-in-time universe.",
      "Prevent overtrading — minimum 4-bar rebalance cadence.",
      "Keep regime gate for trend_up only."
    ],
    createStrategy: async (candidateId, params) => {
      const family = BLOCK_FAMILY_CATALOG.find(f => f.familyId === "block:rotation-15m-trend-up")!;
      const p = clampParams(params, family.parameterSpecs);
      return createRelativeStrengthRotationStrategy({
        strategyId: `${candidateId}-rotation`,
        rebalanceBars: p.rebalanceBars,
        entryFloor: p.entryFloor,
        reEntryCooldownBars: 3,
        exitFloor: p.exitFloor,
        switchGap: p.switchGap,
        minAboveTrendRatio: p.minAboveTrendRatio,
        minLiquidityScore: p.minLiquidityScore,
        minCompositeTrend: p.minCompositeTrend
      });
    }
  },
  {
    familyId: "block:leader-1h-trend-up",
    strategyName: "block:leader-1h-trend-up",
    title: "1h Leader Pullback Block (trend_up)",
    thesis: "Leader pullback state machine on 1h decision, 5m execution, gated to trend-up regime.",
    timeframe: "1h",
    requiredData: ["1h", "5m"],
    parameterSpecs: [
      { name: "strengthFloor", description: "Leader percentile floor.", min: 0.55, max: 0.92 },
      { name: "pullbackAtr", description: "Pullback depth in ATR.", min: 0.4, max: 1.6 },
      { name: "setupExpiryBars", description: "Setup expiry bars.", min: 2, max: 12 },
      { name: "trailAtrMult", description: "Trailing ATR multiple.", min: 1.2, max: 3.4 },
      ...REGIME_GATE_TREND_UP_SPECS
    ],
    guardrails: [
      "Favor clear trend leadership.",
      "Keep regime gate for trend_up."
    ],
    createStrategy: async (candidateId, params) => {
      const family = BLOCK_FAMILY_CATALOG.find(f => f.familyId === "block:leader-1h-trend-up")!;
      const p = clampParams(params, family.parameterSpecs);
      return createLeaderPullbackStateMachineMultiStrategy({
        strategyId: `${candidateId}-leader`,
        strengthFloor: p.strengthFloor,
        pullbackAtr: p.pullbackAtr,
        setupExpiryBars: p.setupExpiryBars,
        trailAtrMult: p.trailAtrMult
      });
    }
  },
  {
    familyId: "block:reversion-1h-rangedown",
    strategyName: "block:reversion-1h-rangedown",
    title: "1h Residual Reversion Block (range + trend_down)",
    thesis: "Residual reversion on 1h decision, 5m execution, gated to range and trend-down regimes.",
    timeframe: "1h",
    requiredData: ["1h", "5m"],
    parameterSpecs: [
      { name: "entryThreshold", description: "Reversion entry threshold.", min: 0.20, max: 0.60 },
      { name: "exitThreshold", description: "Reversion exit threshold.", min: 0.05, max: 0.3 },
      { name: "stopLossPct", description: "Stop loss percentage.", min: 0.015, max: 0.04 },
      { name: "maxHoldBars", description: "Max hold bars.", min: 8, max: 72 },
      ...REGIME_GATE_RANGE_DOWN_SPECS
    ],
    guardrails: [
      "Only trade large reversions to overcome costs.",
      "Gate to range and trend_down regimes."
    ],
    createStrategy: async (candidateId, params) => {
      const family = BLOCK_FAMILY_CATALOG.find(f => f.familyId === "block:reversion-1h-rangedown")!;
      const p = clampParams(params, family.parameterSpecs);
      return createResidualReversionMultiStrategy({
        strategyId: `${candidateId}-reversion`,
        entryThreshold: p.entryThreshold,
        exitThreshold: p.exitThreshold,
        stopLossPct: p.stopLossPct,
        maxHoldBars: p.maxHoldBars
      });
    }
  },
  {
    familyId: "block:pullback-1h-trend-up",
    strategyName: "block:pullback-1h-trend-up",
    title: "1h Relative Momentum Pullback Block (trend_up)",
    thesis: "Relative momentum pullback on 1h decision, 5m execution, gated to trend-up regime.",
    timeframe: "1h",
    requiredData: ["1h", "5m"],
    parameterSpecs: [
      { name: "minStrengthPct", description: "Relative strength floor.", min: 0.6, max: 0.95 },
      { name: "minRiskOn", description: "Risk-on threshold.", min: -0.05, max: 0.35 },
      { name: "pullbackZ", description: "Pullback z-score depth.", min: 0.3, max: 2.2 },
      { name: "trailAtrMult", description: "Trailing ATR multiple.", min: 1.2, max: 3.2 },
      ...REGIME_GATE_TREND_UP_SPECS
    ],
    guardrails: [
      "Long-only, pullback-and-reclaim semantics.",
      "Gate to trend_up regime."
    ],
    createStrategy: async (candidateId, params) => {
      const family = BLOCK_FAMILY_CATALOG.find(f => f.familyId === "block:pullback-1h-trend-up")!;
      const p = clampParams(params, family.parameterSpecs);
      return createRelativeMomentumPullbackMultiStrategy({
        strategyId: `${candidateId}-pullback`,
        minStrengthPct: p.minStrengthPct,
        minRiskOn: p.minRiskOn,
        pullbackZ: p.pullbackZ,
        trailAtrMult: p.trailAtrMult
      });
    }
  },
  {
    familyId: "block:bb-reversion-1h",
    strategyName: "block:bb-reversion-1h",
    title: "1h Bollinger Touch Mean Reversion (weekly-like)",
    thesis: "Entry is driven by a weekly-like 1h Bollinger lower-band touch. Extreme current-bar touches can enter immediately, otherwise a reclaim confirmation is required. RSI informs conviction and exits. Profit targets scale with Bollinger width, with wide stop loss and disciplined re-entry spacing.",
    timeframe: "1h",
    requiredData: ["1h", "5m"],
    parameterSpecs: BB_MEAN_REVERSION_WEEKLY_SPECS,
    guardrails: [
      "Long-only, entry is either an extreme current-bar touch or a recent lower-band touch followed by reclaim confirmation.",
      "bbWindow must be 120+ (5+ days of 1h bars) to simulate weekly BB.",
      "Wide stop loss (20-35%) — crypto volatility.",
      "Regime-adaptive exit: trend_up holds longer, trend_down sells faster.",
      "NO regime gate — BB oversold happens in all regimes."
    ],
    createStrategy: createBbReversionFactory("block:bb-reversion-1h", "bb-weekly", false)
  },
  {
    familyId: "block:bb-rsi-confirmed-reversion-1h",
    strategyName: "block:bb-rsi-confirmed-reversion-1h",
    title: "1h Bollinger RSI-Confirmed Mean Reversion (weekly-like)",
    thesis: "Entry requires a weekly-like 1h Bollinger lower-band touch plus RSI oversold confirmation. Extreme current-bar touches can enter immediately, otherwise reclaim confirmation is required. This is the stricter weekly-like mean-reversion block with width-aware profit targets.",
    timeframe: "1h",
    requiredData: ["1h", "5m"],
    parameterSpecs: BB_MEAN_REVERSION_WEEKLY_SPECS,
    guardrails: [
      "Long-only, entry requires either an extreme current-bar touch or a lower-band touch plus reclaim confirmation, with RSI oversold confirmation.",
      "bbWindow must be 120+ (5+ days of 1h bars) to simulate weekly BB.",
      "Wide stop loss (20-35%) — crypto volatility.",
      "Regime-adaptive exit: trend_up holds longer, trend_down sells faster.",
      "NO regime gate — BB oversold happens in all regimes."
    ],
    createStrategy: createBbReversionFactory("block:bb-rsi-confirmed-reversion-1h", "bb-weekly", true)
  },
  {
    familyId: "block:bb-reversion-1h-daily",
    strategyName: "block:bb-reversion-1h-daily",
    title: "1h Bollinger Touch Mean Reversion (daily-like)",
    thesis: "Entry is driven by a daily-scale 1h Bollinger lower-band touch. Extreme current-bar touches can enter immediately, otherwise reclaim confirmation is required. RSI informs conviction and faster exits. Profit targets scale with Bollinger width and re-entry is disciplined.",
    timeframe: "1h",
    requiredData: ["1h", "5m"],
    parameterSpecs: BB_MEAN_REVERSION_DAILY_SPECS,
    guardrails: [
      "Long-only, entry is either an extreme current-bar touch or a recent lower-band touch followed by reclaim confirmation.",
      "bbWindow 20-48 (1-2 days of 1h bars) for daily-scale BB.",
      "Faster exit than weekly variant — lower RSI target.",
      "Regime-adaptive exit: trend_up holds longer, trend_down sells faster.",
      "NO regime gate — BB oversold happens in all regimes."
    ],
    createStrategy: createBbReversionFactory("block:bb-reversion-1h-daily", "bb-daily", false)
  },
  {
    familyId: "block:bb-rsi-confirmed-reversion-1h-daily",
    strategyName: "block:bb-rsi-confirmed-reversion-1h-daily",
    title: "1h Bollinger RSI-Confirmed Mean Reversion (daily-like)",
    thesis: "Entry requires a daily-scale 1h Bollinger lower-band touch plus RSI oversold confirmation. Extreme current-bar touches can enter immediately, otherwise reclaim confirmation is required. This is the stricter faster-exit daily-like block with width-aware profit targets.",
    timeframe: "1h",
    requiredData: ["1h", "5m"],
    parameterSpecs: BB_MEAN_REVERSION_DAILY_SPECS,
    guardrails: [
      "Long-only, entry requires either an extreme current-bar touch or a lower-band touch plus reclaim confirmation, with RSI oversold confirmation.",
      "bbWindow 20-48 (1-2 days of 1h bars) for daily-scale BB.",
      "Faster exit than weekly variant — lower RSI target.",
      "Regime-adaptive exit: trend_up holds longer, trend_down sells faster.",
      "NO regime gate — BB oversold happens in all regimes."
    ],
    createStrategy: createBbReversionFactory("block:bb-rsi-confirmed-reversion-1h-daily", "bb-daily", true)
  },
  {
    familyId: "block:bb-reversion-1h-hourly",
    strategyName: "block:bb-reversion-1h-hourly",
    title: "1h Bollinger Touch Mean Reversion (hourly-like)",
    thesis: "Entry is driven by a short hourly-scale 1h Bollinger lower-band touch. Extreme current-bar touches can enter immediately, otherwise reclaim confirmation is required. Profit targets scale with Bollinger width and exits are tuned for quick reversions above fees.",
    timeframe: "1h",
    requiredData: ["1h", "5m"],
    parameterSpecs: BB_MEAN_REVERSION_HOURLY_SPECS,
    guardrails: [
      "Long-only, entry is either an extreme current-bar touch or a recent lower-band touch followed by reclaim confirmation.",
      "bbWindow 12-36 for hourly-scale mean reversion on 1h candles.",
      "Smaller profit targets than daily/weekly, but still above fee drag.",
      "Fast exits and tighter stop loss than slower variants.",
      "NO regime gate — BB oversold happens in all regimes."
    ],
    createStrategy: createBbReversionFactory("block:bb-reversion-1h-hourly", "bb-hourly", false)
  },
  {
    familyId: "block:bb-rsi-confirmed-reversion-1h-hourly",
    strategyName: "block:bb-rsi-confirmed-reversion-1h-hourly",
    title: "1h Bollinger RSI-Confirmed Mean Reversion (hourly-like)",
    thesis: "Entry requires an hourly-scale 1h Bollinger lower-band touch plus RSI oversold confirmation. Extreme current-bar touches can enter immediately, otherwise reclaim confirmation is required. This is the stricter faster hourly-like block.",
    timeframe: "1h",
    requiredData: ["1h", "5m"],
    parameterSpecs: BB_MEAN_REVERSION_HOURLY_SPECS,
    guardrails: [
      "Long-only, entry requires either an extreme current-bar touch or a lower-band touch plus reclaim confirmation, with RSI oversold confirmation.",
      "bbWindow 12-36 for hourly-scale mean reversion on 1h candles.",
      "Smaller profit targets than daily/weekly, but still above fee drag.",
      "Fast exits and tighter stop loss than slower variants.",
      "NO regime gate — BB oversold happens in all regimes."
    ],
    createStrategy: createBbReversionFactory("block:bb-rsi-confirmed-reversion-1h-hourly", "bb-hourly", true)
  },
  {
    familyId: "block:micro-breakout-15m-upvol",
    strategyName: "block:micro-breakout-15m-upvol",
    title: "15m Micro Breakout Block (trend_up + volatile)",
    thesis: "Micro breakout on 15m candles, gated to trend-up and volatile regimes.",
    timeframe: "15m",
    requiredData: ["15m", "5m"],
    parameterSpecs: [
      { name: "lookbackBars", description: "Lookback bars for range detection.", min: 5, max: 18 },
      { name: "extensionThreshold", description: "Minimum breakout extension.", min: 0.0015, max: 0.009 },
      { name: "holdingBarsMax", description: "Max hold bars.", min: 4, max: 20 },
      { name: "stopAtrMult", description: "Stop ATR multiple.", min: 0.8, max: 1.8 },
      { name: "minVolumeSpike", description: "Min volume spike ratio.", min: 0.8, max: 1.5 },
      { name: "minRiskOnScore", description: "Regime min risk-on score.", min: -0.02, max: 0.2 },
      { name: "minLiquidityScore", description: "Regime min liquidity score.", min: 0.02, max: 0.12 },
      { name: "profitTarget", description: "Profit target %.", min: 0.0015, max: 0.012 },
      ...REGIME_GATE_VOLATILE_SPECS
    ],
    guardrails: [
      "Long-only, micro breakout.",
      "Gate to trend_up + volatile regimes."
    ],
    createStrategy: async (candidateId, params) => {
      const family = BLOCK_FAMILY_CATALOG.find(f => f.familyId === "block:micro-breakout-15m-upvol")!;
      const p = clampParams(params, family.parameterSpecs);
      return createMicroBreakoutStrategy({
        strategyId: `${candidateId}-micro`,
        lookbackBars: p.lookbackBars,
        extensionThreshold: p.extensionThreshold,
        holdingBarsMax: p.holdingBarsMax,
        stopAtrMult: p.stopAtrMult,
        minVolumeSpike: p.minVolumeSpike,
        minRiskOnScore: p.minRiskOnScore,
        minLiquidityScore: p.minLiquidityScore,
        profitTarget: p.profitTarget
      });
    }
  },
  {
    familyId: "block:breakout-1h-trend-up",
    strategyName: "block:breakout-1h-trend-up",
    title: "1h Relative Breakout Rotation Block (trend_up)",
    thesis: "Relative breakout rotation on 1h decision, 5m execution, gated to trend-up regime.",
    timeframe: "1h",
    requiredData: ["1h", "5m"],
    parameterSpecs: [
      { name: "breakoutLookback", description: "Breakout lookback bars.", min: 12, max: 36 },
      { name: "strengthFloor", description: "Strength percentile floor.", min: 0.65, max: 0.95 },
      { name: "maxExtensionAtr", description: "Max extension in ATR.", min: 0.8, max: 2.2 },
      { name: "trailAtrMult", description: "Trailing ATR multiple.", min: 1.2, max: 3.4 },
      ...REGIME_GATE_TREND_UP_SPECS
    ],
    guardrails: [
      "Long-only, breakout rotation.",
      "Gate to trend_up regime."
    ],
    createStrategy: async (candidateId, params) => {
      const family = BLOCK_FAMILY_CATALOG.find(f => f.familyId === "block:breakout-1h-trend-up")!;
      const p = clampParams(params, family.parameterSpecs);
      return createRelativeBreakoutRotationMultiStrategy({
        strategyId: `${candidateId}-breakout`,
        breakoutLookback: p.breakoutLookback,
        strengthFloor: p.strengthFloor,
        maxExtensionAtr: p.maxExtensionAtr,
        trailAtrMult: p.trailAtrMult
      });
    }
  }
],

// ---------------------------------------------------------------------------
// Simple strategy families — 5-6 params each, actually searchable
// ---------------------------------------------------------------------------

SIMPLE_FAMILY_CATALOG: StrategyFamilyDefinition[] = [
  {
    familyId: "block:simple-ema-crossover-1h",
    sleeveId: "trend",
    family: "trend",
    create: (p) => createEmaCrossoverStrategy(p),
    strategyName: "ema-crossover",
    title: "EMA Crossover Trend Following",
    thesis: "Buy on golden cross (fast EMA > slow EMA), sell on death cross. Classic trend-following with 5 params.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "fastPeriod", description: "Fast EMA period.", min: 5, max: 20 },
      { name: "slowPeriod", description: "Slow EMA period.", min: 20, max: 60 },
      { name: "atrStopMult", description: "ATR multiplier for trailing stop.", min: 1.0, max: 4.0 },
      { name: "maxHoldBars", description: "Maximum bars to hold a position.", min: 24, max: 168 },
      { name: "minAtrPct", description: "Minimum ATR/price ratio to avoid flat markets.", min: 0.002, max: 0.02 }
    ],
    guardrails: [
      "Long-only, trend-following.",
      "Only 5 parameters — designed for systematic optimization.",
      "fastPeriod must be less than slowPeriod."
    ]
  },
  {
    familyId: "block:simple-donchian-breakout-1h",
    sleeveId: "breakout",
    family: "breakout",
    create: (p) => createDonchianBreakoutStrategy(p),
    strategyName: "donchian-breakout",
    title: "Donchian Channel Breakout",
    thesis: "Buy when price breaks above N-bar high, exit below shorter-period low. Turtle Trading approach with 5 params.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "entryLookback", description: "Bars for upper channel (entry breakout).", min: 10, max: 48 },
      { name: "exitLookback", description: "Bars for lower channel (exit).", min: 5, max: 24 },
      { name: "stopAtrMult", description: "ATR multiplier for stop loss.", min: 1.0, max: 4.0 },
      { name: "maxHoldBars", description: "Maximum bars to hold a position.", min: 24, max: 168 },
      { name: "minChannelWidth", description: "Minimum channel width as % of price.", min: 0.01, max: 0.06 }
    ],
    guardrails: [
      "Long-only, breakout-following.",
      "Only 5 parameters.",
      "entryLookback should be >= exitLookback."
    ]
  },
  {
    familyId: "block:simple-rsi-reversion-1h",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createSimpleRsiReversionStrategy(p),
    strategyName: "simple-rsi-reversion",
    title: "Simple RSI Mean Reversion",
    thesis: "Buy when RSI oversold, sell when RSI overbought. Pure mean reversion with 5 params, no filters.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "rsiPeriod", description: "RSI calculation period.", min: 7, max: 28 },
      { name: "oversold", description: "RSI level to trigger buy.", min: 15, max: 40 },
      { name: "overbought", description: "RSI level to trigger sell.", min: 55, max: 85 },
      { name: "stopLossPct", description: "Hard stop loss percentage.", min: 0.02, max: 0.10 },
      { name: "maxHoldBars", description: "Maximum bars to hold.", min: 12, max: 96 }
    ],
    guardrails: [
      "Long-only, mean reversion.",
      "Only 5 parameters — no regime gates, no benchmark coupling.",
      "oversold must be < overbought."
    ]
  },
  {
    familyId: "block:simple-bb-reversion-1h",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createSimpleBbReversionStrategy(p),
    strategyName: "simple-bb-reversion",
    title: "Simple Bollinger Mean Reversion",
    thesis: "Buy below lower BB + RSI oversold, sell at middle BB or RSI mean. Same idea as the complex version but with 6 params instead of 41.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "bbWindow", description: "Bollinger Band SMA window.", min: 10, max: 40 },
      { name: "bbMultiplier", description: "Bollinger Band std deviation multiplier.", min: 1.5, max: 3.0 },
      { name: "rsiPeriod", description: "RSI calculation period.", min: 7, max: 28 },
      { name: "entryRsi", description: "RSI must be below this to enter.", min: 15, max: 40 },
      { name: "exitRsi", description: "RSI target for mean reversion exit.", min: 40, max: 65 },
      { name: "stopLossPct", description: "Hard stop loss percentage.", min: 0.02, max: 0.10 }
    ],
    guardrails: [
      "Long-only, mean reversion.",
      "Only 6 parameters — the core of what the 41-param version does.",
      "entryRsi must be < exitRsi."
    ]
  },
  {
    familyId: "block:simple-momentum-1h",
    sleeveId: "trend",
    family: "trend",
    create: (p) => createMomentumRotationStrategy(p),
    strategyName: "momentum-rotation",
    title: "Simple Momentum",
    thesis: "Buy coins with strong positive momentum, sell when momentum reverses. 5 params.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "momentumLookback", description: "Bars to measure momentum.", min: 8, max: 48 },
      { name: "entryMomentumPct", description: "Minimum momentum % to enter.", min: 0.01, max: 0.08 },
      { name: "exitMomentumPct", description: "Momentum % below which to exit.", min: -0.03, max: 0.01 },
      { name: "maxHoldBars", description: "Maximum bars to hold.", min: 12, max: 96 },
      { name: "stopLossPct", description: "Hard stop loss percentage.", min: 0.02, max: 0.10 }
    ],
    guardrails: [
      "Long-only, momentum-following.",
      "Only 5 parameters."
    ]
  },
  {
    familyId: "block:simple-oversold-bounce-1h",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createOversoldBounceScalpStrategy(p),
    strategyName: "oversold-bounce-scalp",
    title: "Oversold Bounce Scalp",
    thesis: "Bear-market strategy: enter only on extreme oversold (low RSI + below BB lower), take small profit quickly (1-3%), cut losses fast. Max 12 bars hold.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "rsiPeriod", description: "RSI calculation period.", min: 7, max: 21 },
      { name: "rsiEntry", description: "RSI extreme oversold threshold.", min: 8, max: 25 },
      { name: "bbWindow", description: "Bollinger Band window.", min: 14, max: 30 },
      { name: "bbMultiplier", description: "BB multiplier (wider = more selective).", min: 1.8, max: 3.5 },
      { name: "profitTargetPct", description: "Take profit at this % gain.", min: 0.005, max: 0.04 },
      { name: "stopLossPct", description: "Stop loss %.", min: 0.01, max: 0.05 }
    ],
    guardrails: [
      "Long-only, bear-market bounce scalping.",
      "6 parameters. Very selective entry, quick exit.",
      "rsiEntry should be very low (8-25) for extreme oversold only."
    ]
  },
  {
    familyId: "block:simple-crash-dip-1h",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createCrashDipBuyStrategy(p),
    strategyName: "crash-dip-buy",
    title: "Crash Dip Buy",
    thesis: "Buy after sharp single-bar drops (>N*ATR), ride the dead cat bounce. Very short hold (4-12 bars), tight profit target and stop.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "atrPeriod", description: "ATR calculation period.", min: 10, max: 20 },
      { name: "dropAtrMult", description: "Minimum drop size in ATR multiples to trigger entry.", min: 1.5, max: 4.0 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.005, max: 0.03 },
      { name: "stopLossPct", description: "Stop loss %.", min: 0.01, max: 0.04 },
      { name: "maxHoldBars", description: "Maximum bars to hold.", min: 4, max: 16 }
    ],
    guardrails: [
      "Long-only, crash bounce strategy.",
      "5 parameters. Enters only on sharp drops.",
      "Very short holding period — in and out quickly."
    ]
  },
  {
    familyId: "block:simple-volume-breakout-rider-1h",
    sleeveId: "trend",
    family: "trend",
    create: (p) => createVolumeBreakoutRiderStrategy(p),
    strategyName: "volume-breakout-rider",
    title: "Volume Breakout Trend Rider",
    thesis: "Bull-market strategy: enter on EMA golden cross with volume confirmation, ATR trailing stop lets winners run. No fixed profit target — captures full trend moves.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "emaFast", description: "Fast EMA period.", min: 5, max: 15 },
      { name: "emaSlow", description: "Slow EMA period.", min: 20, max: 50 },
      { name: "volumeWindow", description: "Volume average window.", min: 10, max: 30 },
      { name: "volumeSpikeMult", description: "Volume spike threshold (multiple of avg).", min: 1.3, max: 3.0 },
      { name: "atrPeriod", description: "ATR period for trailing stop.", min: 10, max: 20 },
      { name: "atrTrailMult", description: "ATR trailing stop multiplier.", min: 1.5, max: 4.0 },
      { name: "maxHoldBars", description: "Maximum bars to hold.", min: 24, max: 168 }
    ],
    guardrails: [
      "Long-only, trend-following with volume confirmation.",
      "7 parameters. ATR trailing stop instead of fixed profit target.",
      "emaFast must be < emaSlow."
    ]
  },
  {
    familyId: "block:simple-volume-exhaustion-1h",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createVolumeExhaustionBounceStrategy(p),
    strategyName: "volume-exhaustion-bounce",
    title: "Volume Exhaustion Bounce",
    thesis: "Bear-market strategy: detects capitulation via multi-bar drop + volume spike + RSI extreme. More reliable than single-bar crash detection. Quick profit-taking.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "dropLookback", description: "Bars to measure the drop.", min: 3, max: 8 },
      { name: "dropThresholdPct", description: "Minimum drop % to trigger.", min: 0.03, max: 0.12 },
      { name: "volumeWindow", description: "Volume average window.", min: 10, max: 30 },
      { name: "volumeSpikeMult", description: "Volume spike threshold.", min: 1.5, max: 4.0 },
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiEntry", description: "RSI oversold entry.", min: 10, max: 30 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.01, max: 0.05 }
    ],
    guardrails: [
      "Long-only, bear-market bounce strategy.",
      "7 parameters. Triple confirmation: drop + volume + RSI.",
      "Adaptive stop = 1.5x profit target."
    ]
  },
  {
    familyId: "block:simple-bb-squeeze-1h",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createBbSqueezeScalpStrategy(p),
    strategyName: "bb-squeeze-scalp",
    title: "BB Squeeze Scalp",
    thesis: "Sideways strategy: trade only when BB width is contracted (squeeze). Buy at lower band with RSI oversold, sell at upper band. Inactive during trends.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "bbWindow", description: "BB calculation window.", min: 14, max: 30 },
      { name: "bbMultiplier", description: "BB multiplier.", min: 1.5, max: 3.0 },
      { name: "squeezeMaxWidth", description: "Max BB width to allow entry (squeeze filter).", min: 0.02, max: 0.08 },
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiOversold", description: "RSI oversold entry.", min: 20, max: 40 },
      { name: "rsiOverbought", description: "RSI overbought exit.", min: 55, max: 80 }
    ],
    guardrails: [
      "Long-only, sideways-market mean reversion.",
      "6 parameters. BB squeeze filter prevents trend-market entries.",
      "rsiOversold must be < rsiOverbought."
    ]
  },
  {
    familyId: "block:simple-rs-bounce-1h",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createRelativeStrengthBounceStrategy(p),
    strategyName: "relative-strength-bounce",
    title: "Relative Strength Volume Bounce",
    thesis: "All-regime strategy: buy relatively strong coins (high momentum percentile) on RSI oversold + volume spike. ATR trailing stop. Key insight: strong coins bounce harder even in bear markets.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "minMomentumPercentile", description: "Min momentum percentile vs universe (0-1).", min: 0.4, max: 0.85 },
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiEntry", description: "RSI oversold entry.", min: 15, max: 40 },
      { name: "volumeWindow", description: "Volume average window.", min: 10, max: 30 },
      { name: "volumeSpikeMult", description: "Volume spike threshold.", min: 1.2, max: 3.0 },
      { name: "atrPeriod", description: "ATR period for trailing stop.", min: 10, max: 20 },
      { name: "atrTrailMult", description: "ATR trailing stop multiplier.", min: 1.5, max: 3.5 }
    ],
    guardrails: [
      "Long-only, relative-strength filtered.",
      "7 parameters. Uses marketState.relativeStrength for coin selection.",
      "ATR trailing stop — no fixed profit target."
    ]
  },
  {
    familyId: "block:simple-trend-accel-1h",
    sleeveId: "trend",
    family: "trend",
    create: (p) => createTrendAccelerationStrategy(p),
    strategyName: "trend-acceleration",
    title: "Trend Acceleration Rider",
    thesis: "Bull-market strategy: enter when a strong coin's momentum is accelerating (not just positive). Volume confirmation + relative strength filter + ATR trailing stop.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "minMomentumPercentile", description: "Min momentum percentile.", min: 0.5, max: 0.9 },
      { name: "momentumLookback", description: "Momentum calculation lookback.", min: 6, max: 24 },
      { name: "accelerationLookback", description: "Bars ago to compare momentum for acceleration.", min: 3, max: 12 },
      { name: "volumeWindow", description: "Volume average window.", min: 10, max: 30 },
      { name: "volumeMinMult", description: "Minimum volume vs average.", min: 1.0, max: 2.5 },
      { name: "atrPeriod", description: "ATR period.", min: 10, max: 20 },
      { name: "atrTrailMult", description: "ATR trailing stop multiplier.", min: 1.5, max: 4.0 }
    ],
    guardrails: [
      "Long-only, momentum acceleration.",
      "7 parameters. Requires momentum increasing, not just positive.",
      "Relative strength filter picks top performers."
    ]
  },
  {
    familyId: "block:simple-stochastic-rsi-reversion-1h",
    sleeveId: "micro",
    strategyName: "stochastic-rsi-reversion",
    title: "Stochastic RSI Mean Reversion",
    thesis: "Stochastic %K < 20 + RSI < 35 = oversold extreme. Enter on K crossing above D (bounce confirmation), exit on overbought or ATR stop. 7 params.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "stochPeriod", description: "Stochastic lookback period.", min: 8, max: 21 },
      { name: "stochOversold", description: "Stochastic %K oversold threshold.", min: 12, max: 25 },
      { name: "rsiPeriod", description: "RSI confirmation period.", min: 10, max: 21 },
      { name: "rsiOversold", description: "RSI oversold confirmation threshold.", min: 25, max: 40 },
      { name: "atrPeriod", description: "ATR period for stop-loss.", min: 10, max: 20 },
      { name: "atrStopMult", description: "ATR multiplier for stop distance.", min: 1.5, max: 3.5 },
      { name: "exitOverbought", description: "Stochastic %K take-profit level.", min: 65, max: 85 }
    ],
    guardrails: [
      "Long-only, mean reversion.",
      "7 parameters — dual oscillator confirmation reduces false signals.",
      "No regime gate — oversold happens in all regimes."
    ]
  },
  {
    familyId: "block:simple-macd-histogram-reversal-1h",
    sleeveId: "trend",
    strategyName: "macd-histogram-reversal",
    title: "MACD Histogram Momentum Reversal",
    thesis: "MACD histogram crosses zero from below while price above EMA = bearish-to-bullish momentum shift. ATR trailing stop. 7 params.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "macdFast", description: "MACD fast EMA window.", min: 8, max: 16 },
      { name: "macdSlow", description: "MACD slow EMA window.", min: 20, max: 32 },
      { name: "macdSignal", description: "MACD signal smoothing window.", min: 6, max: 12 },
      { name: "emaTrendPeriod", description: "EMA trend filter period.", min: 20, max: 60 },
      { name: "atrPeriod", description: "ATR period for trailing stop.", min: 10, max: 20 },
      { name: "atrTrailMult", description: "ATR trailing stop multiplier.", min: 1.5, max: 3.5 },
      { name: "histMinStrength", description: "Minimum histogram value after zero-cross.", min: 0, max: 50 }
    ],
    guardrails: [
      "Long-only, trend-following momentum.",
      "7 parameters — trend filter prevents counter-trend entries.",
      "macdFast must be < macdSlow."
    ]
  },
  {
    familyId: "block:simple-vol-exhaustion-5m",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createVolumeExhaustionBounce5mStrategy(p),
    strategyName: "volume-exhaustion-5m",
    title: "5m Volume Exhaustion Bounce",
    thesis: "5m micro-capitulation: multi-bar drop + volume spike + RSI oversold. Same concept as 1h but 12x more opportunities. Tight profit target 0.5-1.5%.",
    timeframe: "5m",
    requiredData: ["5m"],
    parameterSpecs: [
      { name: "dropLookback", description: "Bars to measure drop.", min: 3, max: 12 },
      { name: "dropThresholdPct", description: "Min drop % to trigger.", min: 0.01, max: 0.04 },
      { name: "volumeWindow", description: "Volume average window.", min: 12, max: 36 },
      { name: "volumeSpikeMult", description: "Volume spike threshold.", min: 1.5, max: 3.5 },
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiEntry", description: "RSI oversold entry.", min: 12, max: 35 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.003, max: 0.02 }
    ],
    guardrails: [
      "Long-only, 5m scalp.",
      "7 parameters. Triple confirmation: drop + volume + RSI.",
      "Max hold 36 bars (3 hours). Adaptive stop = 2x profit target."
    ]
  },
  {
    familyId: "block:simple-oversold-scalp-5m",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createOversoldScalp5mStrategy(p),
    strategyName: "oversold-scalp-5m",
    title: "5m Oversold Scalp",
    thesis: "5m RSI + BB oversold entry with tight profit target. Quick in-and-out for micro bounces.",
    timeframe: "5m",
    requiredData: ["5m"],
    parameterSpecs: [
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiEntry", description: "RSI oversold entry.", min: 10, max: 30 },
      { name: "bbWindow", description: "BB window.", min: 14, max: 30 },
      { name: "bbMultiplier", description: "BB multiplier.", min: 1.5, max: 3.0 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.002, max: 0.015 },
      { name: "stopLossPct", description: "Stop loss %.", min: 0.005, max: 0.02 }
    ],
    guardrails: [
      "Long-only, 5m scalp.",
      "6 parameters. Max hold 24 bars (2 hours)."
    ]
  },
  {
    familyId: "block:simple-momentum-burst-5m",
    sleeveId: "breakout",
    family: "breakout",
    create: (p) => createMomentumBurst5mStrategy(p),
    strategyName: "momentum-burst-5m",
    title: "5m Momentum Burst",
    thesis: "Catch short-term momentum bursts with volume confirmation. ATR trailing stop lets bursts run. Works in all regimes.",
    timeframe: "5m",
    requiredData: ["5m"],
    parameterSpecs: [
      { name: "momentumLookback", description: "Bars for momentum.", min: 6, max: 24 },
      { name: "momentumThresholdPct", description: "Min momentum % for entry.", min: 0.005, max: 0.03 },
      { name: "volumeWindow", description: "Volume average window.", min: 12, max: 36 },
      { name: "volumeSpikeMult", description: "Volume spike threshold.", min: 1.3, max: 3.0 },
      { name: "atrPeriod", description: "ATR period.", min: 10, max: 20 },
      { name: "atrTrailMult", description: "ATR trailing stop.", min: 1.2, max: 3.0 }
    ],
    guardrails: [
      "Long-only, 5m momentum.",
      "6 parameters. ATR trailing stop, max 48 bars (4 hours)."
    ]
  },
  {
    familyId: "block:simple-stochastic-rsi-reversion-5m",
    sleeveId: "micro",
    strategyName: "stochastic-rsi-reversion-5m",
    title: "5m Stochastic RSI Scalp Reversion",
    thesis: "5m oversold stochastic + RSI bounce = micro-reversion scalp. Tight stop, fast exit. 7 params.",
    timeframe: "5m",
    requiredData: ["5m"],
    parameterSpecs: [
      { name: "stochPeriod", description: "Stochastic lookback period.", min: 8, max: 21 },
      { name: "stochOversold", description: "Stochastic %K oversold threshold.", min: 12, max: 25 },
      { name: "rsiPeriod", description: "RSI confirmation period.", min: 8, max: 18 },
      { name: "rsiOversold", description: "RSI oversold threshold.", min: 25, max: 40 },
      { name: "atrPeriod", description: "ATR period for stop-loss.", min: 8, max: 18 },
      { name: "atrStopMult", description: "ATR stop multiplier.", min: 1.0, max: 2.5 },
      { name: "exitOverbought", description: "Stochastic %K take-profit.", min: 60, max: 80 }
    ],
    guardrails: [
      "Long-only, 5m scalp mean reversion.",
      "7 parameters — fast entry/exit for micro dips.",
      "No regime gate — oversold happens in all regimes."
    ]
  },
  {
    familyId: "block:simple-ema-macd-trend-15m",
    sleeveId: "trend",
    strategyName: "ema-macd-trend-15m",
    title: "15m EMA + MACD Trend Following",
    thesis: "EMA20 > EMA50 + MACD histogram positive = 15m uptrend. Trail with ATR stop. 7 params.",
    timeframe: "15m",
    requiredData: ["15m"],
    parameterSpecs: [
      { name: "emaFast", description: "Fast EMA period.", min: 10, max: 25 },
      { name: "emaSlow", description: "Slow EMA period.", min: 30, max: 60 },
      { name: "macdFast", description: "MACD fast window.", min: 8, max: 16 },
      { name: "macdSlow", description: "MACD slow window.", min: 20, max: 32 },
      { name: "atrPeriod", description: "ATR for trailing stop.", min: 10, max: 20 },
      { name: "atrTrailMult", description: "ATR trailing multiplier.", min: 1.5, max: 3.5 },
      { name: "minGapPct", description: "Min EMA gap % to confirm trend.", min: 0.001, max: 0.01 }
    ],
    guardrails: [
      "Long-only, 15m trend-following.",
      "7 parameters — EMA cross + MACD confirmation.",
      "emaFast must be < emaSlow, macdFast must be < macdSlow."
    ]
  },
  {
    familyId: "block:simple-cci-volume-reversion-5m",
    sleeveId: "micro",
    strategyName: "cci-volume-reversion-5m",
    title: "5m CCI Volume Scalp Reversion",
    thesis: "CCI extreme + volume spike on 5m = micro-capitulation, fast 15-60min reversion. 7 params.",
    timeframe: "5m",
    requiredData: ["5m"],
    parameterSpecs: [
      { name: "cciPeriod", description: "CCI calculation period.", min: 8, max: 20 },
      { name: "cciEntry", description: "CCI extreme entry threshold.", min: -200, max: -80 },
      { name: "cciExit", description: "CCI mean reversion exit.", min: -20, max: 20 },
      { name: "volSpikeLookback", description: "Volume average lookback.", min: 10, max: 30 },
      { name: "volSpikeMin", description: "Minimum volume spike ratio.", min: 1.2, max: 3.0 },
      { name: "atrPeriod", description: "ATR period for stop.", min: 8, max: 18 },
      { name: "atrStopMult", description: "ATR stop multiplier.", min: 1.0, max: 2.5 }
    ],
    guardrails: [
      "Long-only, 5m scalp mean reversion.",
      "7 parameters — volume confirmation for micro-dips.",
      "No regime gate."
    ]
  },
  {
    familyId: "block:simple-cci-volume-reversion-1h",
    sleeveId: "micro",
    strategyName: "cci-volume-reversion",
    title: "CCI Extreme + Volume Spike Reversion",
    thesis: "CCI < -100 with volume spike > 1.5x = capitulation selling. Enter when CCI recovering, exit at CCI mean (0) or on stop. 7 params.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "cciPeriod", description: "CCI calculation period.", min: 10, max: 25 },
      { name: "cciEntry", description: "CCI extreme entry threshold (negative).", min: -200, max: -80 },
      { name: "cciExit", description: "CCI mean reversion exit target.", min: -20, max: 30 },
      { name: "volSpikeLookback", description: "Volume average lookback.", min: 10, max: 30 },
      { name: "volSpikeMin", description: "Minimum volume spike ratio.", min: 1.2, max: 3.0 },
      { name: "atrPeriod", description: "ATR period for stop-loss.", min: 10, max: 20 },
      { name: "atrStopMult", description: "ATR stop multiplier.", min: 1.5, max: 3.5 }
    ],
    guardrails: [
      "Long-only, mean reversion.",
      "7 parameters — volume confirmation filters noise.",
      "No regime gate — capitulation happens in all regimes."
    ]
  },
  {
    familyId: "block:simple-obv-accumulation-bounce-1h",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createObvAccumulationBounceStrategy(p),
    strategyName: "obv-accumulation-bounce",
    title: "OBV Accumulation Bounce",
    thesis: "Bear-market accumulation detection: price drops but OBV slope positive = smart money buying while retail panics. Combined with RSI oversold for timing. Max 24 bar hold.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "obvLookback", description: "OBV slope calculation lookback.", min: 5, max: 20 },
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiEntry", description: "RSI oversold entry.", min: 25, max: 45 },
      { name: "dropLookback", description: "Bars to measure price drop.", min: 5, max: 20 },
      { name: "minDropPct", description: "Minimum price drop % to trigger.", min: 0.02, max: 0.08 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.01, max: 0.05 },
      { name: "stopLossPct", description: "Stop loss %.", min: 0.015, max: 0.05 }
    ],
    guardrails: [
      "Long-only, bear-market accumulation bounce.",
      "7 parameters. Triple confirmation: price drop + OBV positive + RSI oversold.",
      "Max 24 bars hold, exits on RSI recovery above 55."
    ]
  },
  {
    familyId: "block:simple-consecutive-red-bounce-1h",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createConsecutiveRedBounceStrategy(p),
    strategyName: "consecutive-red-bounce",
    title: "Consecutive Red Candle Bounce",
    thesis: "Bear-market strategy: after N+ consecutive red (close<open) candles, buy the expected mean-reversion bounce. Extended selling exhausts supply. RSI filter prevents entries that are still too high. Quick profit target.",
    timeframe: "1h",
    requiredData: ["1h"],
    parameterSpecs: [
      { name: "minRedCandles", description: "Minimum consecutive red candles to trigger entry.", min: 3, max: 8 },
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiMaxEntry", description: "Max RSI to allow entry.", min: 30, max: 50 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.008, max: 0.04 },
      { name: "stopLossPct", description: "Stop loss %.", min: 0.01, max: 0.04 },
      { name: "maxHoldBars", description: "Maximum bars to hold.", min: 6, max: 24 }
    ],
    guardrails: [
      "Long-only, bear-market bounce strategy.",
      "6 parameters. Simple observable pattern.",
      "Higher conviction (+0.1) when 2+ extra red candles beyond minimum."
    ]
  },
  {
    familyId: "block:simple-obv-accumulation-bounce-5m",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createObvAccumulationBounce5mStrategy(p),
    strategyName: "obv-accumulation-5m",
    title: "5m OBV Accumulation Bounce",
    thesis: "5m micro-accumulation: price drops but OBV slope positive = smart money buying on 5m timeframe. RSI oversold timing. Tight 0.5-1.5% profit target. 12x more opportunities than 1h.",
    timeframe: "5m",
    requiredData: ["5m"],
    parameterSpecs: [
      { name: "obvLookback", description: "OBV slope lookback.", min: 6, max: 24 },
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiEntry", description: "RSI oversold entry.", min: 20, max: 40 },
      { name: "dropLookback", description: "Bars to measure drop.", min: 6, max: 24 },
      { name: "minDropPct", description: "Min drop %.", min: 0.008, max: 0.03 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.003, max: 0.015 },
      { name: "stopLossPct", description: "Stop loss %.", min: 0.005, max: 0.02 }
    ],
    guardrails: [
      "Long-only, 5m scalp.",
      "7 parameters. OBV divergence + RSI on 5m.",
      "Max hold 36 bars (3 hours)."
    ]
  },
  {
    familyId: "block:simple-vol-exhaustion-15m",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createVolumeExhaustionBounce15mStrategy(p),
    strategyName: "volume-exhaustion-15m",
    title: "15m Volume Exhaustion Bounce",
    thesis: "15m capitulation: multi-bar drop + volume spike + RSI oversold. Sweet spot between 5m noise and 1h infrequency. 4x more opportunities than 1h, 1/3 fee drag vs 5m.",
    timeframe: "15m",
    requiredData: ["15m"],
    parameterSpecs: [
      { name: "dropLookback", description: "Bars to measure drop.", min: 3, max: 10 },
      { name: "dropThresholdPct", description: "Min drop % to trigger.", min: 0.02, max: 0.08 },
      { name: "volumeWindow", description: "Volume average window.", min: 12, max: 30 },
      { name: "volumeSpikeMult", description: "Volume spike threshold.", min: 1.5, max: 3.5 },
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiEntry", description: "RSI oversold entry.", min: 12, max: 30 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.005, max: 0.03 }
    ],
    guardrails: [
      "Long-only, 15m bear-market bounce.",
      "7 parameters. Triple confirmation: drop + volume + RSI.",
      "Adaptive stop = 1.5x profit target. Max hold 48 bars (12 hours)."
    ]
  },
  {
    familyId: "block:simple-oversold-bounce-15m",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createOversoldBounceScalp15mStrategy(p),
    strategyName: "oversold-bounce-15m",
    title: "15m Oversold Bounce Scalp",
    thesis: "15m RSI + BB extreme oversold entry. Quick profit target, tight stop. Between 5m scalp intensity and 1h selectivity.",
    timeframe: "15m",
    requiredData: ["15m"],
    parameterSpecs: [
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiEntry", description: "RSI extreme oversold.", min: 10, max: 25 },
      { name: "bbWindow", description: "BB window.", min: 14, max: 30 },
      { name: "bbMultiplier", description: "BB multiplier.", min: 1.8, max: 3.0 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.005, max: 0.025 },
      { name: "stopLossPct", description: "Stop loss %.", min: 0.008, max: 0.03 }
    ],
    guardrails: [
      "Long-only, 15m scalp.",
      "6 parameters. Max hold 32 bars (8 hours)."
    ]
  },
  {
    familyId: "block:simple-crash-dip-15m",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createCrashDipBuy15mStrategy(p),
    strategyName: "crash-dip-15m",
    title: "15m Crash Dip Buy",
    thesis: "15m single-bar sharp drop detection via ATR. More responsive than 1h, less noisy than 5m. Short hold, tight targets.",
    timeframe: "15m",
    requiredData: ["15m"],
    parameterSpecs: [
      { name: "atrPeriod", description: "ATR period.", min: 10, max: 20 },
      { name: "dropAtrMult", description: "Drop size in ATR multiples.", min: 1.5, max: 4.0 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.004, max: 0.02 },
      { name: "stopLossPct", description: "Stop loss %.", min: 0.006, max: 0.025 },
      { name: "maxHoldBars", description: "Max bars to hold.", min: 8, max: 32 }
    ],
    guardrails: [
      "Long-only, 15m crash bounce.",
      "5 parameters. Quick in-and-out."
    ]
  },
  {
    familyId: "block:simple-obv-accumulation-15m",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createObvAccumulationBounce15mStrategy(p),
    strategyName: "obv-accumulation-15m",
    title: "15m OBV Accumulation Bounce",
    thesis: "15m accumulation detection: price drops but OBV slope positive. More granular than 1h OBV. RSI timing.",
    timeframe: "15m",
    requiredData: ["15m"],
    parameterSpecs: [
      { name: "obvLookback", description: "OBV slope lookback.", min: 6, max: 20 },
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiEntry", description: "RSI oversold entry.", min: 22, max: 42 },
      { name: "dropLookback", description: "Bars to measure drop.", min: 4, max: 16 },
      { name: "minDropPct", description: "Min drop %.", min: 0.01, max: 0.04 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.005, max: 0.025 },
      { name: "stopLossPct", description: "Stop loss %.", min: 0.008, max: 0.03 }
    ],
    guardrails: [
      "Long-only, 15m accumulation bounce.",
      "7 parameters. OBV divergence + RSI.",
      "Max hold 48 bars (12 hours)."
    ]
  },
  {
    familyId: "block:simple-consecutive-red-15m",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createConsecutiveRedBounce15mStrategy(p),
    strategyName: "consecutive-red-15m",
    title: "15m Consecutive Red Bounce",
    thesis: "15m consecutive red candle bounce. After N+ red 15m candles, buy mean reversion. RSI filter.",
    timeframe: "15m",
    requiredData: ["15m"],
    parameterSpecs: [
      { name: "minRedCandles", description: "Min consecutive red candles.", min: 3, max: 8 },
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiMaxEntry", description: "Max RSI to allow entry.", min: 28, max: 48 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.004, max: 0.02 },
      { name: "stopLossPct", description: "Stop loss %.", min: 0.006, max: 0.025 },
      { name: "maxHoldBars", description: "Max bars to hold.", min: 12, max: 48 }
    ],
    guardrails: [
      "Long-only, 15m bear-market bounce.",
      "6 parameters."
    ]
  },
  {
    familyId: "block:simple-consecutive-red-bounce-5m",
    sleeveId: "micro",
    family: "meanreversion",
    create: (p) => createConsecutiveRedBounce5mStrategy(p),
    strategyName: "consecutive-red-5m",
    title: "5m Consecutive Red Candle Bounce",
    thesis: "5m version: after N+ consecutive red 5m candles, buy micro-bounce. More signal opportunities, tighter targets. RSI filter for timing.",
    timeframe: "5m",
    requiredData: ["5m"],
    parameterSpecs: [
      { name: "minRedCandles", description: "Minimum consecutive red candles.", min: 4, max: 12 },
      { name: "rsiPeriod", description: "RSI period.", min: 7, max: 21 },
      { name: "rsiMaxEntry", description: "Max RSI to allow entry.", min: 25, max: 45 },
      { name: "profitTargetPct", description: "Take profit %.", min: 0.002, max: 0.012 },
      { name: "stopLossPct", description: "Stop loss %.", min: 0.004, max: 0.015 },
      { name: "maxHoldBars", description: "Max bars to hold.", min: 12, max: 48 }
    ],
    guardrails: [
      "Long-only, 5m scalp.",
      "6 parameters. Simple pattern, tight targets."
    ]
  }
];

function attachCreateStrategy(family: StrategyFamilyDefinition): StrategyFamilyDefinition {
  if (family.createStrategy) return family;

  // Simple strategy — use create/sleeveId/family directly from the family definition
  if (family.create && family.sleeveId) {
    const tf = family.timeframe as StrategyTimeframe;
    return {
      ...family,
      createStrategy: async (candidateId, params) => {
        const clamped = clampParams(params, family.parameterSpecs);
        return adaptScoredStrategy({
          strategyId: `${candidateId}-${tf}`,
          sleeveId: family.sleeveId!,
          family: family.family ?? "meanreversion",
          decisionTimeframe: tf,
          executionTimeframe: tf,
          scoredStrategy: family.create!(clamped)
        });
      }
    };
  }

  // Generated strategy — dynamic import
  const generatedPath = GENERATED_STRATEGY_MODULES[family.familyId];
  if (generatedPath) {
    return {
      ...family,
      createStrategy: async (candidateId, params) => {
        const mod = await import(generatedPath);
        return mod.createStrategy({ strategyId: candidateId, parameters: params });
      }
    };
  }

  // No factory available — will fall through to dynamic loader in evaluator
  return family;
}

export function getBlockFamilyDefinitions(): StrategyFamilyDefinition[] {
  return [...BLOCK_FAMILY_CATALOG, ...SIMPLE_FAMILY_CATALOG].map(attachCreateStrategy);
}

export function getBlockFamilyById(id: string): StrategyFamilyDefinition {
  const found = BLOCK_FAMILY_CATALOG.find((family) => family.familyId === id)
    ?? SIMPLE_FAMILY_CATALOG.find((family) => family.familyId === id);
  if (!found) {
    throw new Error(`Unknown block family: ${id}`);
  }
  return attachCreateStrategy(found);
}
