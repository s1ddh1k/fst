import type { ResearchParameterSpec, StrategyFamilyDefinition } from "./types.js";

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
  { name: "gateMaxRiskOnScore", description: "Regime gate risk-on ceiling.", min: -0.2, max: 0.3 },
  { name: "gateMaxTrendScore", description: "Regime gate trend-score ceiling.", min: -0.2, max: 0.25 },
  { name: "gateMaxVolatility", description: "Regime gate volatility ceiling.", min: 0.015, max: 0.08 }
];

const BLOCK_FAMILY_CATALOG: StrategyFamilyDefinition[] = [
  {
    familyId: "block:rotation-15m-trend-up",
    strategyName: "block:rotation-15m-trend-up",
    title: "15m Rotation Block (trend_up)",
    thesis: "Relative strength rotation on 15m decision, 5m execution, gated to trend-up regime.",
    timeframe: "15m",
    requiredData: ["15m", "5m"],
    parameterSpecs: [
      { name: "rebalanceBars", description: "Rebalance cadence in 15m bars.", min: 4, max: 8 },
      { name: "entryFloor", description: "Rotation entry floor.", min: 0.68, max: 0.88 },
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
    ]
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
    ]
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
    ]
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
    ]
  }
];

export function getBlockFamilyDefinitions(): StrategyFamilyDefinition[] {
  return BLOCK_FAMILY_CATALOG.slice();
}

export function getBlockFamilyById(id: string): StrategyFamilyDefinition {
  const found = BLOCK_FAMILY_CATALOG.find((family) => family.familyId === id);
  if (!found) {
    throw new Error(`Unknown block family: ${id}`);
  }
  return found;
}
