import {
  createMovingAverageCrossStrategy,
  createRegimeFilteredMovingAverageCrossStrategy,
  createRsiMeanReversionStrategy,
  createTemplateBreakoutTrendVolumeStrategy,
  createTemplateMeanReversionBandsStrategy,
  createVolatilityBreakoutStrategy,
  createVolumeFilteredBreakoutStrategy
} from "../../../research/strategies/src/index.js";
import type { Strategy } from "../../../research/strategies/src/types.js";

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
    default:
      throw new Error(`Unsupported strategy for paper trading: ${params.strategyName}`);
  }
}
