import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listScoredStrategyNames } from "../strategy-registry.js";
import { resolveStrategyFamilyComposition } from "./catalog.js";
import type {
  CatalogEntryRecord,
  CodeMutationExecutionResult,
  ProposedStrategyFamily,
  ValidationCommandResult,
  StrategyFamilyDefinition
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

export function createInitialCatalog(families: StrategyFamilyDefinition[]): CatalogEntryRecord[] {
  const timestamp = nowIso();

  return families.map((family) => ({
    familyId: family.familyId,
    state: "implemented",
    source: "stable",
    strategyName: family.strategyName,
    title: family.title,
    thesis: family.thesis,
    timeframe: family.timeframe,
    parameterSpecs: family.parameterSpecs,
    requiredData: [family.timeframe],
    implementationNotes: family.guardrails.slice(),
    basedOnFamilies: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    notes: ["Imported from stable strategy catalog."]
  }));
}

export function mergeProposedFamilies(
  current: CatalogEntryRecord[],
  proposed: ProposedStrategyFamily[]
): CatalogEntryRecord[] {
  const byId = new Map(current.map((entry) => [entry.familyId, entry]));

  for (const family of proposed) {
    const existing = byId.get(family.familyId);
    const timestamp = nowIso();
    const currentCatalog = Array.from(byId.values());
    const executableBase =
      (family.baseFamilyId ? byId.get(family.baseFamilyId) : undefined) ??
      byId.get(family.basedOnFamilies[0] ?? "");
    const composition = resolveStrategyFamilyComposition(
      family.composition,
      currentCatalog
        .filter((entry): entry is CatalogEntryRecord & { strategyName?: string } => entry.state !== "discarded")
        .map((entry) => ({
          familyId: entry.familyId,
          strategyName: entry.strategyName ?? "",
          title: entry.title,
          thesis: entry.thesis,
          timeframe: entry.timeframe,
          parameterSpecs: entry.parameterSpecs,
          guardrails: entry.implementationNotes,
          composition: entry.composition
        }))
    );
    const strategyName = composition ? `composed:${family.familyId}` : executableBase?.strategyName;
    const inferredState: CatalogEntryRecord["state"] = strategyName ? "implemented" : "proposed";

    if (existing) {
      byId.set(family.familyId, {
        ...existing,
        strategyName,
        compositionDraft: family.composition,
        composition,
        state: strategyName ? (existing.state === "validated" ? "validated" : "implemented") : existing.state,
        title: family.title,
        thesis: family.thesis,
        timeframe: family.timeframe,
        parameterSpecs: family.parameterSpecs,
        requiredData: family.requiredData,
        implementationNotes: family.implementationNotes,
        basedOnFamilies: family.basedOnFamilies,
        updatedAt: timestamp,
        notes: [...existing.notes, "LLM refreshed family proposal."]
      });
      continue;
    }

    byId.set(family.familyId, {
      familyId: family.familyId,
      state: inferredState,
      source: "llm",
      strategyName,
      title: family.title,
      thesis: family.thesis,
      timeframe: family.timeframe,
      parameterSpecs: family.parameterSpecs,
      compositionDraft: family.composition,
      composition,
      requiredData: family.requiredData,
      implementationNotes: family.implementationNotes,
      basedOnFamilies: family.basedOnFamilies,
      createdAt: timestamp,
      updatedAt: timestamp,
      notes: ["Added from auto-research proposal."]
    });
  }

  return refreshCatalogImplementations(
    Array.from(byId.values()).sort((left, right) => left.familyId.localeCompare(right.familyId))
  );
}

export function refreshCatalogImplementations(
  catalog: CatalogEntryRecord[],
  discoveredStrategyNames?: string[]
): CatalogEntryRecord[] {
  const scoredStrategies = new Set(discoveredStrategyNames ?? listScoredStrategyNames());

  return catalog.map((entry) => {
    const resolvedComposition = resolveStrategyFamilyComposition(
      entry.compositionDraft ?? entry.composition,
      catalog
        .filter((item): item is CatalogEntryRecord & { strategyName?: string } => item.state !== "discarded")
        .map((item) => ({
          familyId: item.familyId,
          strategyName:
            item.composition && item.composition.components.length > 0
              ? `composed:${item.familyId}`
              : item.strategyName ?? "",
          title: item.title,
          thesis: item.thesis,
          timeframe: item.timeframe,
          parameterSpecs: item.parameterSpecs,
          guardrails: item.implementationNotes,
          composition: item.composition
        }))
    );

    if (resolvedComposition && resolvedComposition.components.length > 0) {
      return {
        ...entry,
        composition: resolvedComposition,
        strategyName: `composed:${entry.familyId}`,
        state: entry.state === "validated" ? "validated" : "implemented",
        updatedAt: nowIso()
      };
    }

    if (entry.composition && entry.composition.components.length > 0) {
      return {
        ...entry,
        strategyName: `composed:${entry.familyId}`,
        state: entry.state === "validated" ? "validated" : "implemented",
        updatedAt: nowIso()
      };
    }

    if (!scoredStrategies.has(entry.familyId)) {
      return entry;
    }

    return {
      ...entry,
      strategyName: entry.familyId,
      state: entry.state === "validated" ? "validated" : "implemented",
      updatedAt: nowIso(),
      notes: entry.strategyName === entry.familyId
        ? entry.notes
        : [...entry.notes, "Strategy registry now exposes this family directly."]
    };
  });
}

export function applyCodeMutationResultsToCatalog(params: {
  catalog: CatalogEntryRecord[];
  codeMutationResults: CodeMutationExecutionResult[];
  validationResults: ValidationCommandResult[];
  discoveredStrategyNames?: string[];
}): CatalogEntryRecord[] {
  const refreshed = refreshCatalogImplementations(params.catalog, params.discoveredStrategyNames);
  const allValidationPassed = params.validationResults.every((item) => item.status !== "failed");
  const byId = new Map(refreshed.map((entry) => [entry.familyId, entry]));

  for (const result of params.codeMutationResults) {
    if (result.status !== "executed") {
      continue;
    }

    const familyId = result.familyId ?? result.strategyName;
    const strategyName = result.strategyName ?? result.familyId;
    const discovered =
      (strategyName && params.discoveredStrategyNames?.includes(strategyName)) ||
      (familyId && params.discoveredStrategyNames?.includes(familyId));

    if (!familyId) {
      continue;
    }

    const existing = byId.get(familyId);
    if (existing) {
      byId.set(familyId, {
        ...existing,
        strategyName:
          discovered && strategyName
            ? strategyName
            : existing.strategyName,
        state:
      discovered
            ? existing.state === "validated" ? "validated" : "implemented"
            : existing.state,
        updatedAt: nowIso(),
        notes: [
          ...existing.notes,
          discovered
            ? allValidationPassed
              ? `Code mutation executed and runtime discovery found strategy ${strategyName ?? familyId}; validation passed.`
              : `Code mutation executed and runtime discovery found strategy ${strategyName ?? familyId}.`
            : `Code mutation executed for ${familyId} but runtime discovery did not find a new strategy yet.`
        ]
      });
      continue;
    }

    byId.set(familyId, {
      familyId,
      state: discovered ? "implemented" : "proposed",
      source: "llm",
      strategyName: discovered ? strategyName : undefined,
      title: result.title,
      thesis: result.detail || result.title,
      timeframe: "1h",
      parameterSpecs: [],
      requiredData: ["1h"],
      implementationNotes: [],
      basedOnFamilies: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      notes: [
        discovered
          ? `Added from code mutation result and runtime discovery (${strategyName ?? familyId}).`
          : "Added from code mutation result before runtime discovery resolved a strategy."
      ]
    });
  }

  return refreshCatalogImplementations(
    Array.from(byId.values()).sort((left, right) => left.familyId.localeCompare(right.familyId)),
    params.discoveredStrategyNames
  );
}

export function buildRuntimeFamilies(catalog: CatalogEntryRecord[]): StrategyFamilyDefinition[] {
  return refreshCatalogImplementations(catalog)
    .filter((entry): entry is CatalogEntryRecord & { strategyName: string } =>
      typeof entry.strategyName === "string" && entry.state !== "discarded"
    )
    .map((entry) => ({
      familyId: entry.familyId,
      strategyName: entry.strategyName,
      title: entry.title,
      thesis: entry.thesis,
      timeframe: entry.timeframe,
      parameterSpecs: entry.parameterSpecs,
      guardrails: entry.implementationNotes,
      composition: entry.composition
    }));
}

export function markCatalogFamilyState(
  catalog: CatalogEntryRecord[],
  familyId: string,
  state: CatalogEntryRecord["state"],
  note: string
): CatalogEntryRecord[] {
  return catalog.map((entry) =>
    entry.familyId === familyId
      ? {
          ...entry,
          state,
          updatedAt: nowIso(),
          notes: [...entry.notes, note]
        }
      : entry
  );
}

function buildCatalogSummary(catalog: CatalogEntryRecord[]) {
  const byState = catalog.reduce<Record<string, number>>((result, entry) => {
    result[entry.state] = (result[entry.state] ?? 0) + 1;
    return result;
  }, {});
  const bySource = catalog.reduce<Record<string, number>>((result, entry) => {
    result[entry.source] = (result[entry.source] ?? 0) + 1;
    return result;
  }, {});

  return {
    totals: {
      families: catalog.length,
      implemented: catalog.filter((entry) => entry.state === "implemented" || entry.state === "validated").length,
      validated: catalog.filter((entry) => entry.state === "validated").length
    },
    byState,
    bySource,
    families: catalog.map((entry) => ({
      familyId: entry.familyId,
      state: entry.state,
      source: entry.source,
      strategyName: entry.strategyName,
      basedOnFamilies: entry.basedOnFamilies,
      compositionDraft: entry.compositionDraft,
      updatedAt: entry.updatedAt
    }))
  };
}

export async function saveCatalogArtifact(outputDir: string, catalog: CatalogEntryRecord[]): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(
    path.join(outputDir, "catalog-summary.json"),
    `${JSON.stringify(buildCatalogSummary(catalog), null, 2)}\n`
  );
}
