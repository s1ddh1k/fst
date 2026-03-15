import {
  createCrossSectionalMultiFactorAlphaModel,
  type UniverseAlphaModel
} from "../../../research/backtester/src/universe-alpha-model.js";

function toNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, innerValue]) => [key, Number(innerValue)])
  );
}

export type UniversePortfolioRecommendation = {
  alphaModelName: string;
  alphaParameters: Record<string, number>;
  portfolioParameters: {
    maxPositions: number;
    rebalanceBars: number;
    minScore: number;
    marketLimit?: number;
  };
};

export function parseUniversePortfolioRecommendation(
  parametersJson: unknown
): UniversePortfolioRecommendation {
  const root =
    parametersJson && typeof parametersJson === "object" && !Array.isArray(parametersJson)
      ? (parametersJson as Record<string, unknown>)
      : {};
  const alphaParameters = toNumberRecord(root.alphaParameters);
  const portfolioRoot =
    root.portfolioParameters &&
    typeof root.portfolioParameters === "object" &&
    !Array.isArray(root.portfolioParameters)
      ? (root.portfolioParameters as Record<string, unknown>)
      : {};

  return {
    alphaModelName:
      typeof root.alphaModelName === "string"
        ? root.alphaModelName
        : "cross-sectional-multi-factor",
    alphaParameters,
    portfolioParameters: {
      maxPositions: Number(portfolioRoot.maxPositions ?? 5),
      rebalanceBars: Number(portfolioRoot.rebalanceBars ?? 1),
      minScore: Number(portfolioRoot.minScore ?? 0),
      marketLimit:
        portfolioRoot.marketLimit === undefined ? undefined : Number(portfolioRoot.marketLimit)
    }
  };
}

export function createUniverseAlphaModelFromRecommendation(
  parametersJson: unknown
): UniverseAlphaModel {
  const parsed = parseUniversePortfolioRecommendation(parametersJson);

  switch (parsed.alphaModelName) {
    case "cross-sectional-multi-factor":
      return createCrossSectionalMultiFactorAlphaModel({
        ...parsed.alphaParameters
      });
    default:
      throw new Error(`Unsupported universe alpha model: ${parsed.alphaModelName}`);
  }
}
