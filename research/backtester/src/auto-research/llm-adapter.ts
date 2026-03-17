import { createRequire } from "node:module";
import { buildProposalPrompt, buildReviewPrompt } from "./prompt-builder.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  CodeMutationTask,
  ProposedStrategyFamily,
  ProposalBatch,
  PreparationExecutionResult,
  ResearchIterationRecord,
  ReviewDecision,
  StrategyFamilyDefinition
} from "./types.js";

type JsonResponder = (prompt: string, opts: {
  provider?: string;
  model?: string;
  cwd?: string;
}) => Promise<{ data: unknown }>;

export interface ResearchLlmClient {
  proposeCandidates(params: {
    config: AutoResearchRunConfig;
    families: StrategyFamilyDefinition[];
    marketCodes: string[];
    history: ResearchIterationRecord[];
  }): Promise<ProposalBatch>;
  reviewIteration(params: {
    config: AutoResearchRunConfig;
    families: StrategyFamilyDefinition[];
    history: ResearchIterationRecord[];
    latestProposal: ProposalBatch;
    preparationResults: PreparationExecutionResult[];
    codeMutationResults: Array<{
      taskId: string;
      title: string;
      status: "planned" | "executed" | "failed" | "skipped";
      detail: string;
    }>;
    validationResults: Array<{
      command: string;
      status: "passed" | "failed" | "skipped";
      detail: string;
    }>;
    evaluations: CandidateBacktestEvaluation[];
  }): Promise<ReviewDecision>;
}

function resolveUcmLlmPath(): string {
  const home = process.env.HOME;

  if (!home) {
    throw new Error("HOME is required to resolve ~/git/ucm");
  }

  return `${home}/git/ucm/legacy/lib/core/llm.js`;
}

function getJsonResponder(): JsonResponder {
  const require = createRequire(import.meta.url);
  const modulePath = resolveUcmLlmPath();
  const imported = require(modulePath) as { llmJson?: JsonResponder };

  if (typeof imported.llmJson !== "function") {
    throw new Error(`llmJson not found in ${modulePath}`);
  }

  return imported.llmJson;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      throw new Error("Expected JSON object string response from LLM");
    }
  }

  if (Array.isArray(value)) {
    if (value.length === 1) {
      return asRecord(value[0]);
    }

    throw new Error("Expected single JSON object from LLM, received array");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object response from LLM");
  }

  return value as Record<string, unknown>;
}

function parsePreparation(raw: unknown): ProposalBatch["preparation"] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const actions: ProposalBatch["preparation"] = [];

  for (const rawItem of raw) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      continue;
    }

    const item = asRecord(rawItem);
      const kind = item.kind;
      const reason = typeof item.reason === "string" ? item.reason.trim() : "";

      if (!reason || typeof kind !== "string") {
        continue;
      }

      if (kind === "build_feature_cache") {
        const timeframe = item.timeframe;
        if (timeframe !== "1h" && timeframe !== "15m" && timeframe !== "5m" && timeframe !== "1m") {
          continue;
        }

        actions.push({
          kind,
          timeframe,
          reason,
          familyId: typeof item.familyId === "string" ? item.familyId : undefined,
          marketLimit: Number.isFinite(Number(item.marketLimit)) ? Number(item.marketLimit) : undefined,
          limit: Number.isFinite(Number(item.limit)) ? Number(item.limit) : undefined,
          minCandles: Number.isFinite(Number(item.minCandles)) ? Number(item.minCandles) : undefined
        });
        continue;
      }

      if (kind === "sync_latest_batch" || kind === "backfill_batch") {
        const timeframes = Array.isArray(item.timeframes)
          ? item.timeframes.filter((value): value is "1h" | "15m" | "5m" | "1m" | "1d" =>
              value === "1h" || value === "15m" || value === "5m" || value === "1m" || value === "1d"
            )
          : [];

        if (timeframes.length === 0) {
          continue;
        }

        if (kind === "sync_latest_batch") {
          actions.push({
            kind,
            timeframes,
            reason,
            markets: Array.isArray(item.markets)
              ? item.markets.filter((value): value is string => typeof value === "string")
              : undefined
          });
          continue;
        }

        actions.push({
          kind,
          timeframes,
          pages: Number.isFinite(Number(item.pages)) ? Math.max(1, Math.round(Number(item.pages))) : 1,
          reason,
          markets: Array.isArray(item.markets)
            ? item.markets.filter((value): value is string => typeof value === "string")
            : undefined
        });
      }
  }

  return actions;
}

function parseCandidates(raw: unknown) {
  if (!Array.isArray(raw)) {
    throw new Error("LLM response missing candidates array");
  }

  return raw.map((item) => {
    const record = asRecord(item);
    const parameters = asRecord(record.parameters);
    const normalizedParameters = Object.fromEntries(
      Object.entries(parameters)
        .filter(([, value]) => Number.isFinite(value))
        .map(([key, value]) => [key, Number(value)])
    );

    return {
      candidateId: typeof record.candidateId === "string" ? record.candidateId : undefined,
      familyId: String(record.familyId ?? ""),
      thesis: String(record.thesis ?? ""),
      parameters: normalizedParameters,
      invalidationSignals: Array.isArray(record.invalidationSignals)
        ? record.invalidationSignals.filter((value): value is string => typeof value === "string")
        : []
    };
  });
}

function parseParameterSpecs(raw: unknown): ProposedStrategyFamily["parameterSpecs"] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item) => {
    const record = asRecord(item);
    const min = Number(record.min);
    const max = Number(record.max);

    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      return [];
    }

    return [{
      name: String(record.name ?? "").trim(),
      description: String(record.description ?? "").trim(),
      min,
      max
    }];
  }).filter((spec) => spec.name.length > 0);
}

function parseProposedFamilies(raw: unknown): ProposedStrategyFamily[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const record = asRecord(item);
    const familyId = String(record.familyId ?? "").trim();
    const title = String(record.title ?? "").trim();
    const thesis = String(record.thesis ?? "").trim();
    const parameterSpecs = parseParameterSpecs(record.parameterSpecs);

    if (!familyId || parameterSpecs.length === 0) {
      return [];
    }

    return [{
      familyId,
      title: title || familyId,
      thesis: thesis || String(record.reason ?? "").trim() || "LLM proposed family expansion.",
      timeframe: "1h",
      baseFamilyId: typeof record.baseFamilyId === "string" ? record.baseFamilyId : undefined,
      basedOnFamilies: Array.isArray(record.basedOnFamilies)
        ? record.basedOnFamilies.filter((value): value is string => typeof value === "string")
        : [],
      parameterSpecs,
      requiredData: Array.isArray(record.requiredData)
        ? record.requiredData.filter((value): value is string => typeof value === "string")
        : [],
      implementationNotes: Array.isArray(record.implementationNotes)
        ? record.implementationNotes.filter((value): value is string => typeof value === "string")
        : []
    }];
  });
}

function parseCodeTasks(raw: unknown): CodeMutationTask[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const tasks: CodeMutationTask[] = [];

  for (const item of raw) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) {
        tasks.push({
          title: text.slice(0, 80),
          intent: "refactor_research_loop",
          rationale: text,
          acceptanceCriteria: ["Task is investigated and implemented if justified."],
          targetFiles: [],
          prompt: text
        });
      }
      continue;
    }

    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const record = asRecord(item);
    const intent = record.intent;
    if (
      intent !== "fix_bug" &&
      intent !== "implement_strategy" &&
      intent !== "refactor_research_loop" &&
      intent !== "extend_catalog"
    ) {
      continue;
    }

    const title = String(record.title ?? "").trim();
    const rationale = String(record.rationale ?? "").trim();
    const prompt = String(record.prompt ?? "").trim();
    if (!title || !rationale || !prompt) {
      continue;
    }

    tasks.push({
      taskId: typeof record.taskId === "string" ? record.taskId : undefined,
      title,
      intent,
      rationale,
      acceptanceCriteria: Array.isArray(record.acceptanceCriteria)
        ? record.acceptanceCriteria.filter((value): value is string => typeof value === "string")
        : [],
      targetFiles: Array.isArray(record.targetFiles)
        ? record.targetFiles.filter((value): value is string => typeof value === "string")
        : [],
      prompt
    });
  }

  return tasks;
}

export class UcmResearchLlmClient implements ResearchLlmClient {
  private readonly llmJson: JsonResponder;

  constructor(
    private readonly options: {
      provider?: string;
      model?: string;
      cwd?: string;
    }
  ) {
    this.llmJson = getJsonResponder();
  }

  async proposeCandidates(params: {
    config: AutoResearchRunConfig;
    families: StrategyFamilyDefinition[];
    marketCodes: string[];
    history: ResearchIterationRecord[];
  }): Promise<ProposalBatch> {
    const prompt = buildProposalPrompt(params);
    const { data } = await this.llmJson(prompt, this.options);
    const response = asRecord(data);

    return {
      researchSummary: String(response.researchSummary ?? "").trim(),
      preparation: parsePreparation(response.preparation),
      proposedFamilies: parseProposedFamilies(response.proposedFamilies),
      codeTasks: parseCodeTasks(response.codeTasks),
      candidates: parseCandidates(response.candidates)
    };
  }

  async reviewIteration(params: {
    config: AutoResearchRunConfig;
    families: StrategyFamilyDefinition[];
    history: ResearchIterationRecord[];
    latestProposal: ProposalBatch;
    preparationResults: PreparationExecutionResult[];
    codeMutationResults: Array<{
      taskId: string;
      title: string;
      status: "planned" | "executed" | "failed" | "skipped";
      detail: string;
    }>;
    validationResults: Array<{
      command: string;
      status: "passed" | "failed" | "skipped";
      detail: string;
    }>;
    evaluations: CandidateBacktestEvaluation[];
  }): Promise<ReviewDecision> {
    const prompt = buildReviewPrompt(params);
    const { data } = await this.llmJson(prompt, this.options);
    const response = asRecord(data);
    const verdict = response.verdict;

    if (
      verdict !== "keep_searching" &&
      verdict !== "promote_candidate" &&
      verdict !== "stop_no_edge"
    ) {
      throw new Error(`Invalid review verdict: ${String(verdict)}`);
    }

    return {
      summary: String(response.summary ?? "").trim(),
      verdict,
      promotedCandidateId:
        typeof response.promotedCandidateId === "string" ? response.promotedCandidateId : undefined,
      nextPreparation: parsePreparation(response.nextPreparation),
      proposedFamilies: parseProposedFamilies(response.proposedFamilies),
      codeTasks: parseCodeTasks(response.codeTasks),
      nextCandidates: parseCandidates(response.nextCandidates ?? []),
      retireCandidateIds: Array.isArray(response.retireCandidateIds)
        ? response.retireCandidateIds.filter((value): value is string => typeof value === "string")
        : [],
      observations: Array.isArray(response.observations)
        ? response.observations.filter((value): value is string => typeof value === "string")
        : []
    };
  }
}
