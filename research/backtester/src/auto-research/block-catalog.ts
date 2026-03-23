import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  calculateCandidateRiskAdjustedScore,
  resolveEvaluationMaxDrawdown,
  resolveEvaluationTradeCount
} from "./ranking.js";
import type {
  CandidateBacktestEvaluation,
  StrategyFamilyDefinition,
  ValidatedBlock,
  ValidatedBlockCatalog
} from "./types.js";

const ALL_REGIMES = ["trend_up", "trend_down", "range", "volatile"];

function nowIso(): string {
  return new Date().toISOString();
}

function inferExecutionTimeframe(family: StrategyFamilyDefinition): ValidatedBlock["executionTimeframe"] {
  const execution = family.requiredData?.find((timeframe) => timeframe !== family.timeframe);
  return (execution ?? family.timeframe) as ValidatedBlock["executionTimeframe"];
}

function inferBlockMetadata(blockFamilyId: string): Pick<
  ValidatedBlock,
  "strategyType" | "family" | "sleeveId" | "regimeGate"
> {
  if (blockFamilyId.includes("rotation")) {
    return {
      strategyType: "rotation",
      family: "trend",
      sleeveId: "trend",
      regimeGate: { allowedRegimes: ["trend_up"] }
    };
  }

  if (blockFamilyId.includes("leader") || blockFamilyId.includes("pullback")) {
    return {
      strategyType: "pullback",
      family: "trend",
      sleeveId: "trend",
      regimeGate: { allowedRegimes: ["trend_up"] }
    };
  }

  if (blockFamilyId.includes("breakout")) {
    return {
      strategyType: "breakout",
      family: "breakout",
      sleeveId: "breakout",
      regimeGate: { allowedRegimes: ["trend_up", "volatile"] }
    };
  }

  if (blockFamilyId.includes("micro")) {
    return {
      strategyType: "micro",
      family: "micro",
      sleeveId: "micro",
      regimeGate: { allowedRegimes: ["trend_up", "volatile"] }
    };
  }

  if (blockFamilyId.includes("bb-reversion") || blockFamilyId.includes("bb-rsi-confirmed-reversion")) {
    return {
      strategyType: "reversion",
      family: "meanreversion",
      sleeveId: "reversion",
      regimeGate: { allowedRegimes: ALL_REGIMES }
    };
  }

  if (blockFamilyId.includes("rangedown")) {
    return {
      strategyType: "reversion",
      family: "meanreversion",
      sleeveId: "reversion",
      regimeGate: { allowedRegimes: ["range", "trend_down"] }
    };
  }

  return {
    strategyType: "reversion",
    family: "meanreversion",
    sleeveId: "reversion",
    regimeGate: { allowedRegimes: ALL_REGIMES }
  };
}

function normalizeCatalog(input: unknown): ValidatedBlockCatalog {
  const parsed = input as Partial<ValidatedBlockCatalog> | undefined;
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];

  return {
    version: Number.isFinite(parsed?.version) ? Number(parsed?.version) : 1,
    blocks: blocks as ValidatedBlock[],
    updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : nowIso()
  };
}

export function loadValidatedBlockCatalog(catalogJson: string): ValidatedBlockCatalog {
  return normalizeCatalog(JSON.parse(catalogJson));
}

export function createEmptyBlockCatalog(): ValidatedBlockCatalog {
  return {
    version: 1,
    blocks: [],
    updatedAt: nowIso()
  };
}

export function promoteToValidatedBlock(params: {
  evaluation: CandidateBacktestEvaluation;
  familyDef: StrategyFamilyDefinition;
  blockFamilyId: string;
}): ValidatedBlock {
  const { evaluation, familyDef, blockFamilyId } = params;
  const inferred = inferBlockMetadata(blockFamilyId);

  return {
    blockId: `${blockFamilyId}:${evaluation.candidate.candidateId}`,
    strategyType: inferred.strategyType,
    strategyName: familyDef.strategyName,
    decisionTimeframe: familyDef.timeframe,
    executionTimeframe: inferExecutionTimeframe(familyDef),
    family: inferred.family,
    sleeveId: inferred.sleeveId,
    regimeGate: inferred.regimeGate,
    parameters: { ...evaluation.candidate.parameters },
    performance: {
      netReturn: evaluation.summary.netReturn,
      maxDrawdown: resolveEvaluationMaxDrawdown(evaluation),
      tradeCount: resolveEvaluationTradeCount(evaluation),
      positiveWindowRatio: evaluation.diagnostics.windows.positiveWindowRatio ?? 0,
      riskAdjustedScore: calculateCandidateRiskAdjustedScore(evaluation)
    },
    validatedAt: nowIso(),
    sourceFamilyId: blockFamilyId
  };
}

export function appendValidatedBlock(
  catalog: ValidatedBlockCatalog,
  block: ValidatedBlock
): ValidatedBlockCatalog {
  const nextBlocks = catalog.blocks.filter(
    (existing) =>
      existing.blockId !== block.blockId &&
      existing.sourceFamilyId !== block.sourceFamilyId
  );
  nextBlocks.push(block);
  nextBlocks.sort((left, right) => left.sourceFamilyId.localeCompare(right.sourceFamilyId));

  return {
    ...catalog,
    blocks: nextBlocks,
    updatedAt: nowIso()
  };
}

export async function loadValidatedBlockCatalogFromFile(
  catalogPath: string
): Promise<ValidatedBlockCatalog> {
  const raw = await readFile(catalogPath, "utf8");
  return normalizeCatalog(JSON.parse(raw));
}

export async function saveValidatedBlockCatalog(
  catalogPath: string,
  catalog: ValidatedBlockCatalog
): Promise<void> {
  await mkdir(path.dirname(catalogPath), { recursive: true });
  const tempPath = `${catalogPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    tempPath,
    `${JSON.stringify(
      {
        ...catalog,
        updatedAt: nowIso()
      },
      null,
      2
    )}\n`
  );
  await rename(tempPath, catalogPath);
}
