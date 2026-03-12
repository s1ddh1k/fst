import type { Strategy } from "./types.js";
import {
  createMovingAverageCrossStrategy,
  createRegimeFilteredMovingAverageCrossStrategy,
  createRsiMeanReversionStrategy,
  createTemplateBreakoutTrendVolumeStrategy,
  createTemplateMeanReversionBandsStrategy,
  createVolatilityBreakoutStrategy,
  createVolumeFilteredBreakoutStrategy
} from "./strategies-bridge.js";

export function createStrategyByName(name: string): Strategy {
  switch (name) {
    case "moving-average-cross":
      return createMovingAverageCrossStrategy();
    case "volatility-breakout":
      return createVolatilityBreakoutStrategy();
    case "volume-filtered-breakout":
      return createVolumeFilteredBreakoutStrategy();
    case "rsi-mean-reversion":
      return createRsiMeanReversionStrategy();
    case "regime-filtered-moving-average-cross":
      return createRegimeFilteredMovingAverageCrossStrategy();
    case "template-breakout-trend-volume":
      return createTemplateBreakoutTrendVolumeStrategy();
    case "template-mean-reversion-bands":
      return createTemplateMeanReversionBandsStrategy();
    default:
      throw new Error(`Unknown strategy: ${name}`);
  }
}

export function listStrategyNames(): string[] {
  return [
    "moving-average-cross",
    "volatility-breakout",
    "volume-filtered-breakout",
    "rsi-mean-reversion",
    "regime-filtered-moving-average-cross",
    "template-breakout-trend-volume",
    "template-mean-reversion-bands"
  ];
}
