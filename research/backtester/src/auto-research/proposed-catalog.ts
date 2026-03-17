import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listScoredStrategyNames } from "../strategy-registry.js";
import type {
  CatalogEntryRecord,
  ProposedStrategyFamily,
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
    const executableBase =
      (family.baseFamilyId ? byId.get(family.baseFamilyId) : undefined) ??
      byId.get(family.basedOnFamilies[0] ?? "");
    const strategyName = executableBase?.strategyName;
    const inferredState: CatalogEntryRecord["state"] = strategyName ? "implemented" : "proposed";

    if (existing) {
      byId.set(family.familyId, {
        ...existing,
        strategyName,
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

export function refreshCatalogImplementations(catalog: CatalogEntryRecord[]): CatalogEntryRecord[] {
  const scoredStrategies = new Set(listScoredStrategyNames());

  return catalog.map((entry) => {
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
      guardrails: entry.implementationNotes
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

export async function saveCatalogArtifact(outputDir: string, catalog: CatalogEntryRecord[]): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
}
