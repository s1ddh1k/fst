import type { Strategy, StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import type { ResearchParameterSpec } from "./types.js";

export type RegimeGateConfig = {
  allowedRegimes: string[];
};

export type GeneratedStrategyMetadata = {
  familyId: string;
  strategyName: string;
  title: string;
  thesis: string;
  family: "trend" | "breakout" | "micro" | "meanreversion";
  sleeveId: string;
  decisionTimeframe: StrategyTimeframe;
  executionTimeframe: StrategyTimeframe;
  parameterSpecs: ResearchParameterSpec[];
  regimeGate: RegimeGateConfig;
};

export type GeneratedStrategyModule = {
  createStrategy(params: {
    strategyId: string;
    parameters: Record<string, number>;
  }): Strategy;
  metadata: GeneratedStrategyMetadata;
};

export function isValidGeneratedModule(mod: unknown): mod is GeneratedStrategyModule {
  if (!mod || typeof mod !== "object") return false;
  const m = mod as Record<string, unknown>;
  if (typeof m.createStrategy !== "function") return false;
  if (!m.metadata || typeof m.metadata !== "object") return false;
  const meta = m.metadata as Record<string, unknown>;
  return (
    typeof meta.familyId === "string" &&
    typeof meta.strategyName === "string" &&
    typeof meta.family === "string" &&
    typeof meta.sleeveId === "string" &&
    typeof meta.decisionTimeframe === "string" &&
    typeof meta.executionTimeframe === "string" &&
    Array.isArray(meta.parameterSpecs)
  );
}
