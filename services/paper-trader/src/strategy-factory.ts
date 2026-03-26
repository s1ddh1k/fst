import {
  createIntegratedMultiFactorStrategy,
  createMovingAverageCrossStrategy,
  createRegimeFilteredMovingAverageCrossStrategy,
  createRsiMeanReversionStrategy,
  createTemplateBreakoutTrendVolumeStrategy,
  createTemplateMeanReversionBandsStrategy,
  createVolatilityBreakoutStrategy,
  createVolumeFilteredBreakoutStrategy,
  createZscoreRsiReversionGuardedStrategy,
  createZscoreRsiReversionStrategy,
  createZscoreRsiUptrendReversionStrategy,
  createZscoreRsiTrendPullbackStrategy,
  createResidualReversionStrategy,
  createRelativeMomentumPullbackStrategy,
  createLeaderPullbackStateMachineStrategy,
  createRelativeBreakoutRotationStrategy,
  createMomentumReaccelerationStrategy,
  createLeaderBreakoutRetestStrategy,
  createCompressionBreakoutTrendStrategy,
  createLeaderTrendContinuationStrategy,
  createBollingerMeanReversionStrategy,
  createDonchianBreakoutStrategy,
  createEmaCrossoverStrategy,
  createSimpleRsiReversionStrategy,
  createSimpleBbReversionStrategy,
  createMomentumRotationStrategy
} from "../../../research/strategies/src/index.js";
import type { Strategy, ScoredStrategy } from "../../../research/strategies/src/types.js";

function toNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, innerValue]) => [key, Number(innerValue)])
  );
}

export function createStrategyFromRecommendation(params: {
  strategyName: string;
  parametersJson: unknown;
}): Strategy {
  const rootParameters = params.parametersJson;
  const strategyParameters =
    rootParameters &&
    typeof rootParameters === "object" &&
    "strategyParameters" in rootParameters
      ? toNumberRecord((rootParameters as Record<string, unknown>).strategyParameters)
      : toNumberRecord(rootParameters);

  switch (params.strategyName) {
    case "integrated-multi-factor":
      return createIntegratedMultiFactorStrategy(strategyParameters);
    case "moving-average-cross":
      return createMovingAverageCrossStrategy(strategyParameters);
    case "volatility-breakout":
      return createVolatilityBreakoutStrategy(strategyParameters);
    case "volume-filtered-breakout":
      return createVolumeFilteredBreakoutStrategy(strategyParameters);
    case "rsi-mean-reversion":
      return createRsiMeanReversionStrategy(strategyParameters);
    case "regime-filtered-moving-average-cross":
      return createRegimeFilteredMovingAverageCrossStrategy(strategyParameters);
    case "template-breakout-trend-volume":
      return createTemplateBreakoutTrendVolumeStrategy(strategyParameters);
    case "template-mean-reversion-bands":
      return createTemplateMeanReversionBandsStrategy(strategyParameters);
    case "zscore-rsi-reversion":
      return createZscoreRsiReversionStrategy(strategyParameters);
    case "zscore-rsi-reversion-guarded":
      return createZscoreRsiReversionGuardedStrategy(strategyParameters);
    case "zscore-rsi-uptrend-reversion":
      return createZscoreRsiUptrendReversionStrategy(strategyParameters);
    case "zscore-rsi-trend-pullback":
      return createZscoreRsiTrendPullbackStrategy(strategyParameters);
    default:
      throw new Error(`Unsupported strategy for paper trading: ${params.strategyName}`);
  }
}

export function createScoredStrategyFromRecommendation(params: {
  strategyName: string;
  parametersJson: unknown;
}): ScoredStrategy {
  const rootParameters = params.parametersJson;
  const strategyParameters =
    rootParameters &&
    typeof rootParameters === "object" &&
    "strategyParameters" in rootParameters
      ? toNumberRecord((rootParameters as Record<string, unknown>).strategyParameters)
      : toNumberRecord(rootParameters);

  switch (params.strategyName) {
    case "relative-momentum-pullback":
      return createRelativeMomentumPullbackStrategy(strategyParameters);
    case "leader-pullback-state-machine":
      return createLeaderPullbackStateMachineStrategy(strategyParameters);
    case "relative-breakout-rotation":
      return createRelativeBreakoutRotationStrategy(strategyParameters);
    case "momentum-reacceleration":
      return createMomentumReaccelerationStrategy(strategyParameters);
    case "leader-breakout-retest":
      return createLeaderBreakoutRetestStrategy(strategyParameters);
    case "compression-breakout-trend":
      return createCompressionBreakoutTrendStrategy(strategyParameters);
    case "leader-trend-continuation":
      return createLeaderTrendContinuationStrategy(strategyParameters);
    case "residual-reversion":
      return createResidualReversionStrategy(strategyParameters);
    case "bollinger-mean-reversion":
      return createBollingerMeanReversionStrategy(strategyParameters) as ScoredStrategy;
    case "donchian-breakout":
      return createDonchianBreakoutStrategy(strategyParameters);
    case "ema-crossover":
      return createEmaCrossoverStrategy(strategyParameters);
    case "simple-rsi-reversion":
      return createSimpleRsiReversionStrategy(strategyParameters);
    case "simple-bb-reversion":
      return createSimpleBbReversionStrategy(strategyParameters);
    case "momentum-rotation":
      return createMomentumRotationStrategy(strategyParameters);
    default:
      throw new Error(`Unsupported scored strategy for paper trading: ${params.strategyName}`);
  }
}

export function isScoredStrategy(strategyName: string): boolean {
  return [
    "relative-momentum-pullback",
    "leader-pullback-state-machine",
    "relative-breakout-rotation",
    "momentum-reacceleration",
    "leader-breakout-retest",
    "compression-breakout-trend",
    "leader-trend-continuation",
    "residual-reversion",
    "bollinger-mean-reversion",
    "donchian-breakout",
    "ema-crossover",
    "simple-rsi-reversion",
    "simple-bb-reversion",
    "momentum-rotation"
  ].includes(strategyName);
}
