import { getStrategyFamilies } from "./catalog.js";
import type { StrategyFamilyDefinition, ValidatedBlockCatalog } from "./types.js";

function hasBlockFamily(
  catalog: ValidatedBlockCatalog,
  family: "trend" | "breakout" | "micro" | "meanreversion"
): boolean {
  return catalog.blocks.some((block) => block.family === family);
}

function hasDecisionTimeframe(catalog: ValidatedBlockCatalog, timeframe: "15m" | "1h" | "5m" | "1m"): boolean {
  return catalog.blocks.some((block) => block.decisionTimeframe === timeframe);
}

export function getPortfolioCompositionFamilies(
  blockCatalog: ValidatedBlockCatalog
): StrategyFamilyDefinition[] {
  const familyIds = new Set<string>();
  const hasTrend = hasBlockFamily(blockCatalog, "trend");
  const hasBreakout = hasBlockFamily(blockCatalog, "breakout");
  const hasMeanReversion = hasBlockFamily(blockCatalog, "meanreversion");
  const hasMicro = hasBlockFamily(blockCatalog, "micro");
  const has15m = hasDecisionTimeframe(blockCatalog, "15m");
  const has1h = hasDecisionTimeframe(blockCatalog, "1h");

  if (hasTrend && hasBreakout) {
    familyIds.add("multi-tf-regime-core");
    familyIds.add("multi-tf-trend-burst");
  }

  if (hasTrend && hasMeanReversion && has15m && has1h) {
    familyIds.add("multi-tf-defensive-reclaim");
  }

  if (hasTrend && hasBreakout && hasMeanReversion && has15m && has1h) {
    familyIds.add("multi-tf-regime-switch-screen");
  }

  if (hasTrend && hasBreakout && hasMeanReversion && hasMicro && has15m && has1h) {
    familyIds.add("multi-tf-regime-switch");
  }

  return getStrategyFamilies([...familyIds]);
}
