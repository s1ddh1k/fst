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
    ]
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
    ]
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
    ]
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
    ]
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
    ]
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
