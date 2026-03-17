import { createScoredStrategyByName } from "../strategy-registry.js";
import type { ScoredStrategy } from "../../../strategies/src/types.js";
import type {
  CandidateProposal,
  NormalizedCandidateProposal,
  ResolvedStrategyFamilyComposition,
  StrategyFamilyCompositionProposal,
  StrategyFamilyDefinition
} from "./types.js";
import { createComposedScoredStrategy } from "./composed-strategy.js";

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
      "Respect single-position portfolio constraints."
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
