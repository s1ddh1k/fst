import { createScoredStrategyByName } from "../strategy-registry.js";
import type { ScoredStrategy } from "../../../strategies/src/types.js";
import type {
  CandidateProposal,
  NormalizedCandidateProposal,
  ResearchParameterSpec,
  ResolvedStrategyFamilyComposition,
  StrategyFamilyCompositionProposal,
  StrategyFamilyDefinition
} from "./types.js";
import { createComposedScoredStrategy } from "./composed-strategy.js";
import {
  MULTI_TF_DEFENSIVE_RECLAIM_PORTFOLIO,
  MULTI_TF_REGIME_CORE_PORTFOLIO,
  MULTI_TF_REGIME_SWITCH_SCREEN_PORTFOLIO,
  MULTI_TF_REGIME_SWITCH_PORTFOLIO,
  MULTI_TF_TREND_BURST_PORTFOLIO
} from "./portfolio-runtime.js";

const REGIME_SWITCH_SHARED_PARAMETER_SPECS: ResearchParameterSpec[] = [
  { name: "universeTopN", description: "Top-N active universe size.", min: 4, max: 16 },
  { name: "maxOpenPositions", description: "Maximum concurrent positions.", min: 3, max: 6 },
  { name: "maxCapitalUsagePct", description: "Maximum capital usage.", min: 0.35, max: 0.92 },
  { name: "trendBudgetPct", description: "Trend sleeve capital budget.", min: 0.12, max: 0.5 },
  { name: "breakoutBudgetPct", description: "Breakout sleeve capital budget.", min: 0.08, max: 0.4 },
  { name: "microBudgetPct", description: "Reversion and micro sleeve capital budget.", min: 0.05, max: 0.28 },
  { name: "trendRebalanceBars", description: "15m rotation rebalance cadence.", min: 2, max: 8 },
  { name: "trendEntryFloor", description: "15m rotation entry floor.", min: 0.68, max: 0.88 },
  { name: "trendExitFloor", description: "15m rotation exit floor.", min: 0.42, max: 0.72 },
  { name: "trendSwitchGap", description: "15m rotation switch threshold.", min: 0.06, max: 0.18 },
  { name: "trendMinAboveTrendRatio", description: "15m rotation breadth floor.", min: 0.55, max: 0.86 },
  { name: "trendMinLiquidityScore", description: "15m rotation liquidity floor.", min: 0.02, max: 0.25 },
  { name: "trendMinCompositeTrend", description: "15m rotation composite trend floor.", min: -0.05, max: 0.18 },
  { name: "trendMinRiskOnGate", description: "Trend sleeve regime gate risk-on floor.", min: -0.08, max: 0.25 },
  { name: "trendMinTrendScoreGate", description: "Trend sleeve regime gate trend-score floor.", min: -0.05, max: 0.2 },
  { name: "trendGateMinAboveTrendRatio", description: "Trend sleeve regime gate above-trend floor.", min: 0.45, max: 0.8 },
  { name: "trendGateMinLiquidityScore", description: "Trend sleeve regime gate liquidity floor.", min: 0.01, max: 0.25 },
  { name: "leaderStrengthFloor", description: "Hourly leader reclaim strength floor.", min: 0.55, max: 0.92 },
  { name: "leaderPullbackAtr", description: "Hourly leader reclaim pullback depth.", min: 0.4, max: 1.6 },
  { name: "leaderSetupExpiryBars", description: "Leader reclaim setup expiry bars.", min: 2, max: 10 },
  { name: "leaderTrailAtrMult", description: "Leader reclaim trailing ATR multiple.", min: 1.2, max: 3.4 },
  { name: "leaderMinRiskOnGate", description: "Leader sleeve regime gate risk-on floor.", min: -0.08, max: 0.25 },
  { name: "leaderMinTrendScoreGate", description: "Leader sleeve regime gate trend-score floor.", min: -0.05, max: 0.2 },
  { name: "leaderMinLiquidityGate", description: "Leader sleeve regime gate liquidity floor.", min: 0.01, max: 0.25 },
  { name: "breakoutLookback", description: "1h breakout lookback bars.", min: 12, max: 36 },
  { name: "breakoutStrengthFloor", description: "1h breakout strength floor.", min: 0.65, max: 0.95 },
  { name: "breakoutMaxExtensionAtr", description: "1h breakout max extension in ATR.", min: 0.8, max: 2.2 },
  { name: "breakoutTrailAtrMult", description: "1h breakout trailing ATR multiple.", min: 1.2, max: 3.4 },
  { name: "breakoutMinRiskOnGate", description: "Breakout sleeve regime gate risk-on floor.", min: -0.05, max: 0.2 },
  { name: "breakoutMinLiquidityGate", description: "Breakout sleeve regime gate liquidity floor.", min: 0.01, max: 0.25 },
  { name: "breakoutMinVolatilityGate", description: "Breakout sleeve regime gate volatility floor.", min: 0.003, max: 0.04 },
  { name: "reversionEntryThreshold", description: "Residual reversion entry threshold.", min: 0.15, max: 0.45 },
  { name: "reversionExitThreshold", description: "Residual reversion exit threshold.", min: 0.05, max: 0.3 },
  { name: "reversionStopLossPct", description: "Residual reversion stop loss.", min: 0.01, max: 0.04 },
  { name: "reversionMaxHoldBars", description: "Residual reversion max hold bars.", min: 8, max: 48 },
  { name: "reversionMaxRiskOnGate", description: "Reversion sleeve regime gate risk-on ceiling.", min: -0.2, max: 0.3 },
  { name: "reversionMaxTrendScoreGate", description: "Reversion sleeve regime gate trend-score ceiling.", min: -0.2, max: 0.25 },
  { name: "reversionMaxVolatilityGate", description: "Reversion sleeve regime gate volatility ceiling.", min: 0.015, max: 0.08 },
  { name: "cooldownBarsAfterLoss", description: "Portfolio cooldown bars after a loss.", min: 2, max: 24 },
  { name: "minBarsBetweenEntries", description: "Minimum bars between entries.", min: 2, max: 10 },
  { name: "universeLookbackBars", description: "Universe ranking lookback bars.", min: 10, max: 60 }
];

const REGIME_SWITCH_MICRO_PARAMETER_SPECS: ResearchParameterSpec[] = [
  { name: "microLookbackBars", description: "1m scalp breakout lookback bars.", min: 5, max: 18 },
  { name: "microExtensionThreshold", description: "1m scalp breakout distance floor.", min: 0.0015, max: 0.009 },
  { name: "microHoldingBarsMax", description: "1m scalp max holding bars.", min: 4, max: 20 },
  { name: "microStopAtrMult", description: "1m scalp stop ATR multiple.", min: 0.8, max: 1.8 },
  { name: "microMinVolumeSpike", description: "1m scalp volume spike floor.", min: 0.8, max: 1.5 },
  { name: "microMinRiskOnScore", description: "1m scalp internal risk-on floor.", min: -0.02, max: 0.2 },
  { name: "microMinLiquidityScore", description: "1m scalp internal liquidity floor.", min: 0.02, max: 0.12 },
  { name: "microProfitTarget", description: "1m scalp profit target.", min: 0.0015, max: 0.012 },
  { name: "microMinRiskOnGate", description: "1m scalp regime gate risk-on floor.", min: -0.05, max: 0.18 },
  { name: "microMinLiquidityGate", description: "1m scalp regime gate liquidity floor.", min: 0.02, max: 0.15 },
  { name: "microMinVolatilityGate", description: "1m scalp regime gate volatility floor.", min: 0.003, max: 0.03 }
];

const FAMILY_CATALOG: StrategyFamilyDefinition[] = [
  {
    familyId: "relative-momentum-pullback",
    strategyName: "relative-momentum-pullback",
    title: "Relative Momentum Pullback",
    thesis: "Strong coins in a healthy market, bought on pullback-and-reclaim, long only spot.",
    timeframe: "1h",
    parameterSpecs: [
      { name: "minStrengthPct", description: "Relative strength percentile floor.", min: 0.6, max: 0.95 },
      { name: "minRiskOn", description: "Market breadth risk-on threshold.", min: -0.05, max: 0.35 },
      { name: "pullbackZ", description: "Required pullback z-score depth.", min: 0.4, max: 1.8 },
      { name: "trailAtrMult", description: "ATR trailing stop multiple.", min: 1.2, max: 3.2 }
    ],
    guardrails: [
      "Keep long-only semantics.",
      "Do not turn this into fast mean reversion.",
      "Respect portfolio risk caps and position-count constraints."
    ]
  },
  {
    familyId: "leader-pullback-state-machine",
    strategyName: "leader-pullback-state-machine",
    title: "Leader Pullback State Machine",
    thesis: "Only top-ranked leaders qualify; entries require clean pullback and reclaim state transitions.",
    timeframe: "1h",
    parameterSpecs: [
      { name: "strengthFloor", description: "Leader percentile floor.", min: 0.5, max: 0.95 },
      { name: "pullbackAtr", description: "Pullback depth in ATR units.", min: 0.3, max: 1.8 },
      { name: "setupExpiryBars", description: "How long the setup remains valid.", min: 2, max: 8 },
      { name: "trailAtrMult", description: "ATR trailing stop multiple.", min: 1.2, max: 3.2 }
    ],
    guardrails: [
      "Favor clear trend leadership over noisy rebound setups.",
      "Avoid very short expiry values that create 5m-style churn."
    ]
  },
  {
    familyId: "relative-breakout-rotation",
    strategyName: "relative-breakout-rotation",
    title: "Relative Breakout Rotation",
    thesis: "Rotate into leaders that break out from bases without being too extended.",
    timeframe: "1h",
    parameterSpecs: [
      { name: "breakoutLookback", description: "Breakout lookback bars.", min: 8, max: 36 },
      { name: "strengthFloor", description: "Relative strength percentile floor.", min: 0.5, max: 0.95 },
      { name: "maxExtensionAtr", description: "Maximum extension above EMA20 in ATR.", min: 0.4, max: 2.4 },
      { name: "trailAtrMult", description: "ATR trailing stop multiple.", min: 1.2, max: 3.2 }
    ],
    guardrails: [
      "Do not admit late chase entries with very high extension.",
      "Keep regime filters strict enough to avoid trend-down breakouts."
    ]
  },
  {
    familyId: "momentum-reacceleration",
    strategyName: "momentum-reacceleration",
    title: "Momentum Reacceleration",
    thesis: "Strong leaders that reset near EMA20 and re-accelerate without deep pullbacks.",
    timeframe: "1h",
    parameterSpecs: [
      { name: "strengthFloor", description: "Leader percentile floor.", min: 0.55, max: 0.95 },
      { name: "minRiskOn", description: "Risk-on threshold.", min: -0.05, max: 0.35 },
      { name: "resetRsiFloor", description: "Minimum RSI for reset-and-reclaim.", min: 45, max: 58 },
      { name: "trailAtrMult", description: "ATR trailing stop multiple.", min: 1.2, max: 3.2 }
    ],
    guardrails: [
      "Favor continuation after reset, not deep knife catching.",
      "Keep entries near EMA20; avoid high extension chase."
    ]
  },
  {
    familyId: "leader-breakout-retest",
    strategyName: "leader-breakout-retest",
    title: "Leader Breakout Retest",
    thesis: "Leaders that clear a breakout level, retest it, and close back strong.",
    timeframe: "1h",
    parameterSpecs: [
      { name: "strengthFloor", description: "Leader percentile floor.", min: 0.55, max: 0.95 },
      { name: "breakoutLookback", description: "Lookback for breakout reference high.", min: 8, max: 36 },
      { name: "retestAtrBuffer", description: "ATR buffer allowed on breakout retest.", min: 0.1, max: 1.2 },
      { name: "trailAtrMult", description: "ATR trailing stop multiple.", min: 1.2, max: 3.2 }
    ],
    guardrails: [
      "Retest must hold the breakout level.",
      "Do not allow obvious failed breakout bars into the candidate set."
    ]
  },
  {
    familyId: "compression-breakout-trend",
    strategyName: "compression-breakout-trend",
    title: "Compression Breakout Trend",
    thesis: "Strong leaders breaking out of compressed hourly ranges in healthy market regimes.",
    timeframe: "1h",
    parameterSpecs: [
      { name: "strengthFloor", description: "Leader percentile floor.", min: 0.5, max: 0.95 },
      { name: "compressionWindow", description: "Window used to detect compression.", min: 6, max: 18 },
      { name: "compressionAtr", description: "Maximum range width in ATR for compression.", min: 1.2, max: 4.5 },
      { name: "trailAtrMult", description: "ATR trailing stop multiple.", min: 1.2, max: 3.2 }
    ],
    guardrails: [
      "Require real compression before breakout.",
      "Avoid calling wide, sloppy ranges a setup."
    ]
  },
  {
    familyId: "leader-trend-continuation",
    strategyName: "leader-trend-continuation",
    title: "Leader Trend Continuation",
    thesis: "Persistent leaders bought during orderly continuation rather than deep pullback or breakout retest.",
    timeframe: "1h",
    parameterSpecs: [
      { name: "strengthFloor", description: "Leader percentile floor.", min: 0.55, max: 0.95 },
      { name: "minRiskOn", description: "Risk-on threshold.", min: -0.05, max: 0.35 },
      { name: "maxExtensionAtr", description: "Maximum ATR extension above EMA20.", min: 0.4, max: 2.0 },
      { name: "trailAtrMult", description: "ATR trailing stop multiple.", min: 1.2, max: 3.2 }
    ],
    guardrails: [
      "Use for orderly continuation, not vertical chase.",
      "If extension gets too high, the candidate should disappear."
    ]
  },
  {
    familyId: "multi-tf-regime-core",
    strategyName: MULTI_TF_REGIME_CORE_PORTFOLIO,
    title: "Multi-TF Regime Core Portfolio",
    thesis:
      "Blend 15m rotation, 1h pullback, and 1h breakout sleeves over a top-N universe to rotate with regime and trend strength.",
    timeframe: "1h",
    requiredData: ["1h", "15m", "5m"],
    parameterSpecs: [
      { name: "universeTopN", description: "Top-N active universe size.", min: 6, max: 18 },
      { name: "maxOpenPositions", description: "Maximum concurrent positions.", min: 2, max: 6 },
      { name: "maxCapitalUsagePct", description: "Maximum capital usage.", min: 0.45, max: 0.95 },
      { name: "trendBudgetPct", description: "Trend sleeve capital budget.", min: 0.25, max: 0.75 },
      { name: "breakoutBudgetPct", description: "Breakout sleeve capital budget.", min: 0.1, max: 0.45 },
      { name: "trendRebalanceBars", description: "15m rotation rebalance cadence.", min: 1, max: 6 },
      { name: "trendEntryFloor", description: "15m rotation entry floor.", min: 0.58, max: 0.85 },
      { name: "trendExitFloor", description: "15m rotation exit floor.", min: 0.35, max: 0.68 },
      { name: "trendSwitchGap", description: "15m rotation switch threshold.", min: 0.03, max: 0.18 },
      { name: "trendMinAboveTrendRatio", description: "Breadth above-trend floor.", min: 0.45, max: 0.8 },
      { name: "trendMinLiquidityScore", description: "Liquidity floor for rotation sleeve.", min: 0.01, max: 0.25 },
      { name: "trendMinCompositeTrend", description: "Composite trend floor.", min: -0.05, max: 0.2 },
      { name: "pullbackMinStrengthPct", description: "1h pullback strength floor.", min: 0.65, max: 0.92 },
      { name: "pullbackMinRiskOn", description: "1h pullback risk-on threshold.", min: -0.02, max: 0.25 },
      { name: "pullbackZ", description: "1h pullback depth.", min: 0.5, max: 1.5 },
      { name: "pullbackTrailAtrMult", description: "1h pullback trailing ATR multiple.", min: 1.2, max: 3.2 },
      { name: "breakoutLookback", description: "1h breakout lookback bars.", min: 12, max: 36 },
      { name: "breakoutStrengthFloor", description: "1h breakout strength floor.", min: 0.6, max: 0.92 },
      { name: "breakoutMaxExtensionAtr", description: "1h breakout max extension in ATR.", min: 0.8, max: 2.2 },
      { name: "breakoutTrailAtrMult", description: "1h breakout trailing ATR multiple.", min: 1.2, max: 3.2 },
      { name: "cooldownBarsAfterLoss", description: "Portfolio cooldown bars after a loss.", min: 2, max: 24 },
      { name: "minBarsBetweenEntries", description: "Minimum bars between entries.", min: 1, max: 6 },
      { name: "universeLookbackBars", description: "Universe ranking lookback bars.", min: 10, max: 60 }
    ],
    guardrails: [
      "Keep the portfolio long-only and point-in-time.",
      "Do not require 1m execution data for this family; stay within 1h/15m/5m.",
      "Preserve explicit sleeve budgets and risk caps instead of implicit over-allocation."
    ]
  },
  {
    familyId: "multi-tf-trend-burst",
    strategyName: MULTI_TF_TREND_BURST_PORTFOLIO,
    title: "Multi-TF Trend Burst Portfolio",
    thesis:
      "Aggressive trend-up portfolio that stacks 15m rotation, hourly leader pullback, and breakout continuation when breadth is healthy.",
    timeframe: "1h",
    requiredData: ["1h", "15m", "5m"],
    parameterSpecs: [
      { name: "universeTopN", description: "Top-N active universe size.", min: 6, max: 16 },
      { name: "maxOpenPositions", description: "Maximum concurrent positions.", min: 2, max: 6 },
      { name: "maxCapitalUsagePct", description: "Maximum capital usage.", min: 0.5, max: 0.95 },
      { name: "trendBudgetPct", description: "Trend sleeve capital budget.", min: 0.2, max: 0.7 },
      { name: "breakoutBudgetPct", description: "Breakout sleeve capital budget.", min: 0.15, max: 0.5 },
      { name: "trendRebalanceBars", description: "15m rotation rebalance cadence.", min: 1, max: 4 },
      { name: "trendEntryFloor", description: "15m rotation entry floor.", min: 0.62, max: 0.88 },
      { name: "trendExitFloor", description: "15m rotation exit floor.", min: 0.4, max: 0.7 },
      { name: "trendSwitchGap", description: "15m rotation switch threshold.", min: 0.04, max: 0.2 },
      { name: "trendMinAboveTrendRatio", description: "Breadth above-trend floor.", min: 0.5, max: 0.85 },
      { name: "trendMinLiquidityScore", description: "Liquidity floor for rotation sleeve.", min: 0.02, max: 0.25 },
      { name: "trendMinCompositeTrend", description: "Composite trend floor.", min: -0.02, max: 0.2 },
      { name: "leaderStrengthFloor", description: "Hourly leader pullback strength floor.", min: 0.55, max: 0.92 },
      { name: "leaderPullbackAtr", description: "Hourly leader pullback depth in ATR.", min: 0.3, max: 1.4 },
      { name: "leaderSetupExpiryBars", description: "Leader pullback setup expiry bars.", min: 2, max: 8 },
      { name: "leaderTrailAtrMult", description: "Leader pullback trailing ATR multiple.", min: 1.2, max: 3.2 },
      { name: "breakoutLookback", description: "1h breakout lookback bars.", min: 14, max: 40 },
      { name: "breakoutStrengthFloor", description: "1h breakout strength floor.", min: 0.65, max: 0.95 },
      { name: "breakoutMaxExtensionAtr", description: "1h breakout max extension in ATR.", min: 0.8, max: 2 },
      { name: "breakoutTrailAtrMult", description: "1h breakout trailing ATR multiple.", min: 1.2, max: 3.4 },
      { name: "cooldownBarsAfterLoss", description: "Portfolio cooldown bars after a loss.", min: 2, max: 20 },
      { name: "minBarsBetweenEntries", description: "Minimum bars between entries.", min: 1, max: 5 },
      { name: "universeLookbackBars", description: "Universe ranking lookback bars.", min: 10, max: 50 }
    ],
    guardrails: [
      "Use only in risk-on trend conditions; this family should not masquerade as defensive.",
      "Keep breakout chasing bounded with extension controls.",
      "Preserve long-only spot semantics and point-in-time ranking."
    ]
  },
  {
    familyId: "multi-tf-defensive-reclaim",
    strategyName: MULTI_TF_DEFENSIVE_RECLAIM_PORTFOLIO,
    title: "Multi-TF Defensive Reclaim Portfolio",
    thesis:
      "Defensive portfolio that mixes strict 15m rotation, hourly leader reclaim, and residual reversion to survive choppy or fragile tape.",
    timeframe: "1h",
    requiredData: ["1h", "15m", "5m"],
    parameterSpecs: [
      { name: "universeTopN", description: "Top-N active universe size.", min: 4, max: 14 },
      { name: "maxOpenPositions", description: "Maximum concurrent positions.", min: 2, max: 5 },
      { name: "maxCapitalUsagePct", description: "Maximum capital usage.", min: 0.35, max: 0.75 },
      { name: "trendBudgetPct", description: "Trend sleeve capital budget.", min: 0.15, max: 0.5 },
      { name: "reversionBudgetPct", description: "Reversion sleeve capital budget.", min: 0.1, max: 0.35 },
      { name: "trendRebalanceBars", description: "15m rotation rebalance cadence.", min: 2, max: 8 },
      { name: "trendEntryFloor", description: "15m rotation entry floor.", min: 0.62, max: 0.82 },
      { name: "trendExitFloor", description: "15m rotation exit floor.", min: 0.4, max: 0.65 },
      { name: "trendSwitchGap", description: "15m rotation switch threshold.", min: 0.03, max: 0.15 },
      { name: "trendMinAboveTrendRatio", description: "Breadth above-trend floor.", min: 0.5, max: 0.85 },
      { name: "trendMinLiquidityScore", description: "Liquidity floor for rotation sleeve.", min: 0.02, max: 0.25 },
      { name: "trendMinCompositeTrend", description: "Composite trend floor.", min: -0.02, max: 0.18 },
      { name: "leaderStrengthFloor", description: "Hourly leader reclaim strength floor.", min: 0.55, max: 0.95 },
      { name: "leaderPullbackAtr", description: "Hourly leader reclaim pullback depth in ATR.", min: 0.4, max: 1.8 },
      { name: "leaderSetupExpiryBars", description: "Leader reclaim setup expiry bars.", min: 2, max: 10 },
      { name: "leaderTrailAtrMult", description: "Leader reclaim trailing ATR multiple.", min: 1.4, max: 3.4 },
      { name: "reversionEntryThreshold", description: "Residual reversion entry threshold.", min: 0.15, max: 0.45 },
      { name: "reversionExitThreshold", description: "Residual reversion exit threshold.", min: 0.05, max: 0.3 },
      { name: "reversionStopLossPct", description: "Residual reversion stop loss.", min: 0.01, max: 0.04 },
      { name: "reversionMaxHoldBars", description: "Residual reversion max hold bars.", min: 8, max: 48 },
      { name: "cooldownBarsAfterLoss", description: "Portfolio cooldown bars after a loss.", min: 4, max: 30 },
      { name: "minBarsBetweenEntries", description: "Minimum bars between entries.", min: 1, max: 8 },
      { name: "universeLookbackBars", description: "Universe ranking lookback bars.", min: 10, max: 60 }
    ],
    guardrails: [
      "Bias toward capital preservation in choppy tape; do not turn this into a breakout chaser.",
      "Residual reversion must remain tightly risk-capped.",
      "Keep the family long-only and point-in-time."
    ]
  },
  {
    familyId: "multi-tf-regime-switch-screen",
    strategyName: MULTI_TF_REGIME_SWITCH_SCREEN_PORTFOLIO,
    title: "Multi-TF Regime Switch Screen Portfolio",
    thesis:
      "Cheap screen portfolio that rotates 15m trend, hourly continuation, and hourly reversion sleeves before paying the 1m scalp confirmation cost.",
    timeframe: "1h",
    requiredData: ["1h", "15m", "5m"],
    parameterSpecs: REGIME_SWITCH_SHARED_PARAMETER_SPECS,
    guardrails: [
      "Use this as the fast screen stage; do not add 1m data requirements here.",
      "Keep regime switching explicit so the confirm stage inherits a meaningful structure.",
      "Preserve long-only, point-in-time, budget-bounded portfolio behavior."
    ]
  },
  {
    familyId: "multi-tf-regime-switch",
    strategyName: MULTI_TF_REGIME_SWITCH_PORTFOLIO,
    title: "Multi-TF Regime Switch Portfolio",
    thesis:
      "Adaptive portfolio that rotates 15m trend, hourly continuation, hourly reversion, and 1m scalp sleeves based on composite regime and breadth.",
    timeframe: "1h",
    requiredData: ["1h", "15m", "5m", "1m"],
    parameterSpecs: [
      ...REGIME_SWITCH_SHARED_PARAMETER_SPECS,
      ...REGIME_SWITCH_MICRO_PARAMETER_SPECS
    ],
    guardrails: [
      "Make regime switching explicit; do not let all sleeves fire in every environment.",
      "Treat the 1m scalp sleeve as opportunistic, not the main risk budget.",
      "Keep the portfolio long-only, point-in-time, and budget-bounded."
    ]
  }
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function quantize(value: number): number {
  return Number(value.toFixed(4));
}

function resolveComposition(
  composition: StrategyFamilyCompositionProposal | ResolvedStrategyFamilyComposition | undefined,
  familyDefinitions: StrategyFamilyDefinition[]
): ResolvedStrategyFamilyComposition | undefined {
  if (!composition) {
    return undefined;
  }

  const components = composition.components.flatMap((component) => {
    const family = familyDefinitions.find((item) => item.familyId === component.familyId);

    if (!family?.strategyName) {
      return [];
    }

    return [{
      familyId: component.familyId,
      strategyName: family.strategyName,
      weight: Number.isFinite(component.weight) ? Math.max(0.1, Number(component.weight)) : 1,
      parameterBindings: { ...(component.parameterBindings ?? {}) }
    }];
  });

  if (components.length === 0) {
    return undefined;
  }

  return {
    mode: composition.mode,
    buyThreshold: Number.isFinite(composition.buyThreshold)
      ? Math.max(0.05, Number(composition.buyThreshold))
      : 0.5,
    sellThreshold: Number.isFinite(composition.sellThreshold)
      ? Math.max(0.05, Number(composition.sellThreshold))
      : 0.5,
    components
  };
}

export function listStrategyFamilies(): StrategyFamilyDefinition[] {
  return FAMILY_CATALOG.slice();
}

export function getStrategyFamilies(ids?: string[]): StrategyFamilyDefinition[] {
  if (!ids || ids.length === 0) {
    return listStrategyFamilies();
  }

  const requested = new Set(ids);
  return FAMILY_CATALOG.filter((family) => requested.has(family.familyId));
}

export function normalizeCandidateProposal(
  proposal: CandidateProposal,
  familyDefinitions: StrategyFamilyDefinition[],
  candidateIndex: number
): NormalizedCandidateProposal {
  const family = familyDefinitions.find((item) => item.familyId === proposal.familyId);

  if (!family) {
    throw new Error(`Unknown strategy family: ${proposal.familyId}`);
  }

  const normalizedParameters: Record<string, number> = {};

  for (const spec of family.parameterSpecs) {
    const proposed = proposal.parameters[spec.name];

    if (!Number.isFinite(proposed)) {
      throw new Error(`Candidate ${proposal.familyId} missing numeric parameter: ${spec.name}`);
    }

    normalizedParameters[spec.name] = quantize(clamp(proposed, spec.min, spec.max));
  }

  return {
    candidateId: proposal.candidateId ?? `${family.familyId}-${String(candidateIndex + 1).padStart(2, "0")}`,
    familyId: family.familyId,
    strategyName: family.strategyName,
    composition: family.composition,
    thesis: proposal.thesis.trim(),
    parameters: normalizedParameters,
    parentCandidateIds: (proposal.parentCandidateIds ?? []).filter(Boolean).slice(0, 8),
    origin: proposal.origin,
    invalidationSignals: proposal.invalidationSignals
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 6)
  };
}

export function instantiateCandidateStrategy(candidate: NormalizedCandidateProposal): ScoredStrategy {
  if (candidate.composition) {
    return createComposedScoredStrategy({
      name: candidate.strategyName,
      parameters: candidate.parameters,
      composition: candidate.composition,
      createComponent: (strategyName, parameters) => createScoredStrategyByName(strategyName, parameters)
    });
  }

  return createScoredStrategyByName(candidate.strategyName, candidate.parameters);
}

export function resolveStrategyFamilyComposition(
  composition: StrategyFamilyCompositionProposal | ResolvedStrategyFamilyComposition | undefined,
  familyDefinitions: StrategyFamilyDefinition[]
): ResolvedStrategyFamilyComposition | undefined {
  return resolveComposition(composition, familyDefinitions);
}
