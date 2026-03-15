import type { Strategy } from "./types.js";
import type { ScoredStrategy } from "../../strategies/src/types.js";
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
  createZscoreRsiTrendPullbackStrategy
} from "./strategies-bridge.js";
import { createResidualReversionStrategy } from "../../strategies/src/residual-reversion-strategy.js";
import { createLeaderPullbackStateMachineStrategy } from "../../strategies/src/leader-pullback-state-machine.js";
import { createRelativeBreakoutRotationStrategy } from "../../strategies/src/relative-breakout-rotation.js";
import { createRelativeMomentumPullbackStrategy } from "../../strategies/src/relative-momentum-pullback.js";

export function createStrategyByName(
  name: string,
  parameters?: Record<string, number>
): Strategy {
  switch (name) {
    case "integrated-multi-factor":
      return createIntegratedMultiFactorStrategy(parameters);
    case "moving-average-cross":
      return createMovingAverageCrossStrategy(parameters);
    case "volatility-breakout":
      return createVolatilityBreakoutStrategy(parameters);
    case "volume-filtered-breakout":
      return createVolumeFilteredBreakoutStrategy(parameters);
    case "rsi-mean-reversion":
      return createRsiMeanReversionStrategy(parameters);
    case "regime-filtered-moving-average-cross":
      return createRegimeFilteredMovingAverageCrossStrategy(parameters);
    case "template-breakout-trend-volume":
      return createTemplateBreakoutTrendVolumeStrategy(parameters);
    case "template-mean-reversion-bands":
      return createTemplateMeanReversionBandsStrategy(parameters);
    case "zscore-rsi-reversion":
      return createZscoreRsiReversionStrategy(parameters);
    case "zscore-rsi-reversion-guarded":
      return createZscoreRsiReversionGuardedStrategy(parameters);
    case "zscore-rsi-uptrend-reversion":
      return createZscoreRsiUptrendReversionStrategy(parameters);
    case "zscore-rsi-trend-pullback":
      return createZscoreRsiTrendPullbackStrategy(parameters);
    default:
      throw new Error(`Unknown strategy: ${name}`);
  }
}

export function listStrategyNames(): string[] {
  return [
    "integrated-multi-factor",
    "moving-average-cross",
    "volatility-breakout",
    "volume-filtered-breakout",
    "rsi-mean-reversion",
    "regime-filtered-moving-average-cross",
    "template-breakout-trend-volume",
    "template-mean-reversion-bands",
    "zscore-rsi-reversion",
    "zscore-rsi-reversion-guarded",
    "zscore-rsi-uptrend-reversion",
    "zscore-rsi-trend-pullback"
  ];
}

export function createScoredStrategyByName(
  name: string,
  parameters?: Record<string, number>
): ScoredStrategy {
  switch (name) {
    case "relative-momentum-pullback":
      return createRelativeMomentumPullbackStrategy(parameters);
    case "leader-pullback-state-machine":
      return createLeaderPullbackStateMachineStrategy(parameters);
    case "relative-breakout-rotation":
      return createRelativeBreakoutRotationStrategy(parameters);
    case "residual-reversion":
      return createResidualReversionStrategy(parameters);
    default:
      throw new Error(`Unknown scored strategy: ${name}`);
  }
}

export function listScoredStrategyNames(): string[] {
  return [
    "relative-momentum-pullback",
    "leader-pullback-state-machine",
    "relative-breakout-rotation"
  ];
}
