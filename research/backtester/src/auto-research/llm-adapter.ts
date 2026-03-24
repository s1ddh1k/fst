import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildProposalPrompt,
  buildReviewPrompt,
  buildBlockProposalPrompt,
  buildBlockReviewPrompt,
  buildPortfolioCompositionProposalPrompt,
  buildPortfolioCompositionReviewPrompt,
  compactCandidateGenealogy,
  compactCandidateLedger,
  compactCodeMutationResults,
  compactEvaluation,
  compactFamilies,
  compactFamilyPerformance,
  compactPreparationResults,
  compactRecentHistory
} from "./prompt-builder.js";
import { extractJson, llmJson, llmText } from "./cli-llm.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  CodeMutationTask,
  ProposedStrategyFamily,
  ProposalBatch,
  PreparationExecutionResult,
  ResearchIterationRecord,
  ReviewDecision,
  StrategyFamilyDefinition,
  ValidatedBlockCatalog
} from "./types.js";

export interface ResearchLlmClient {
  proposeCandidates(params: {
    config: AutoResearchRunConfig;
    families: StrategyFamilyDefinition[];
    marketCodes: string[];
    history: ResearchIterationRecord[];
    blockCatalog?: ValidatedBlockCatalog;
  }): Promise<ProposalBatch>;
  reviewIteration(params: {
    config: AutoResearchRunConfig;
    families: StrategyFamilyDefinition[];
    history: ResearchIterationRecord[];
    latestProposal: ProposalBatch;
    preparationResults: PreparationExecutionResult[];
    codeMutationResults: Array<{
      taskId: string;
      familyId?: string;
      strategyName?: string;
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
    blockCatalog?: ValidatedBlockCatalog;
  }): Promise<ReviewDecision>;
}

function describeRecordKeys(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Array.isArray(value) ? `array(length=${value.length})` : typeof value;
  }

  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 ? keys.slice(0, 12).join(", ") : "(none)";
}

function previewValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string" && serialized.length > 0) {
      return serialized.length > 240 ? `${serialized.slice(0, 240)}...` : serialized;
    }
  } catch {
    // fall through
  }

  return String(value);
}

function unwrapEnvelopeRecord(
  value: unknown,
  envelopeKeys: string[],
  predicate: (record: Record<string, unknown>) => boolean
): Record<string, unknown> {
  const record = asRecord(value);
  if (predicate(record)) {
    return record;
  }

  for (const key of envelopeKeys) {
    const nested = record[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      continue;
    }

    const nestedRecord = asRecord(nested);
    if (predicate(nestedRecord)) {
      return nestedRecord;
    }
  }

  return record;
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

function parseCandidates(raw: unknown, context?: unknown): ProposalBatch["candidates"] {
  if (!Array.isArray(raw)) {
    const contextSummary = context === undefined
      ? ""
      : ` (top-level keys: ${describeRecordKeys(context)}; preview: ${previewValue(context)})`;
    throw new Error(`LLM response missing candidates array${contextSummary}`);
  }

  return raw.map((item) => {
    const record = asRecord(item);
    const parameters = asRecord(record.parameters);
    const normalizedParameters = Object.fromEntries(
      Object.entries(parameters)
        .filter(([, value]) => Number.isFinite(value))
        .map(([key, value]) => [key, Number(value)])
    );
    const origin: ProposalBatch["candidates"][number]["origin"] =
      record.origin === "llm" ||
      record.origin === "novelized" ||
      record.origin === "resume" ||
      record.origin === "artifact_seed" ||
      record.origin === "engine_mutation" ||
      record.origin === "engine_seed"
        ? record.origin
        : undefined;

    return {
      candidateId: typeof record.candidateId === "string" ? record.candidateId : undefined,
      familyId: String(record.familyId ?? ""),
      thesis: String(record.thesis ?? ""),
      parameters: normalizedParameters,
      parentCandidateIds: Array.isArray(record.parentCandidateIds)
        ? record.parentCandidateIds.filter((value): value is string => typeof value === "string").slice(0, 8)
        : undefined,
      origin,
      invalidationSignals: Array.isArray(record.invalidationSignals)
        ? record.invalidationSignals.filter((value): value is string => typeof value === "string")
        : []
    };
  });
}

function buildKeepSearchingRepairPrompt(params: {
  originalPrompt: string;
  invalidResponse: Record<string, unknown>;
  candidatesPerIteration: number;
}): string {
  return `${params.originalPrompt}

Correction task:
- Provide 1 to ${params.candidatesPerIteration} concrete, unique nextCandidates when you keep verdict="keep_searching".
- Choose verdict="stop_no_edge" when you do not want to provide a next candidate batch.
- Return corrected JSON only.

Previous invalid JSON:
${JSON.stringify(params.invalidResponse, null, 2)}

Final response reminder:
- Fill nextCandidates with unique, executable candidates when you keep searching.
- Let verdict="stop_no_edge" be the clean ending when no next batch is ready.
- Do not emit markdown.
`.trim();
}

function buildJsonExtractionRepairPrompt(params: {
  originalPrompt: string;
  invalidResponsePath: string;
  schemaPath: string;
}): string {
  return `${params.originalPrompt}

Correction task:
- Read the previous raw response at ${params.invalidResponsePath}.
- Rewrite it as valid JSON that matches ${params.schemaPath}.
- Return corrected JSON only.
- Do not emit markdown.
`.trim();
}

async function writeArtifactFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function writeJsonArtifact(filePath: string, value: unknown): Promise<void> {
  await writeArtifactFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function blockHistorySummary(history: ResearchIterationRecord[]) {
  return {
    familyPerformanceSummary: compactFamilyPerformance(history),
    candidateLedgerSummary: compactCandidateLedger(history, 12),
    candidateGenealogy: compactCandidateGenealogy(history, 12),
    recentHistory: compactRecentHistory(history, 2)
  };
}

function buildBlockProposalResponseSchema() {
  return {
    type: "object",
    required: ["researchSummary", "preparation", "proposedFamilies", "codeTasks", "candidates"],
    properties: {
      researchSummary: { type: "string" },
      preparation: { type: "array" },
      proposedFamilies: { type: "array" },
      codeTasks: { type: "array" },
      candidates: { type: "array" }
    }
  };
}

function buildBlockReviewResponseSchema() {
  return {
    type: "object",
    required: [
      "summary",
      "verdict",
      "promotedCandidateId",
      "nextPreparation",
      "proposedFamilies",
      "codeTasks",
      "nextCandidates",
      "retireCandidateIds",
      "observations"
    ],
    properties: {
      summary: { type: "string" },
      verdict: { enum: ["keep_searching", "promote_candidate", "stop_no_edge"] },
      promotedCandidateId: { type: ["string", "null"] },
      nextPreparation: { type: "array" },
      proposedFamilies: { type: "array" },
      codeTasks: { type: "array" },
      nextCandidates: { type: "array" },
      retireCandidateIds: { type: "array" },
      observations: { type: "array" }
    }
  };
}

function buildBlockProposalFilePrompt(params: {
  configPath: string;
  familiesPath: string;
  historyPath: string;
  schemaPath: string;
  candidatesPerIteration: number;
}): string {
  return `
You are proposing BLOCK-level crypto strategy candidates.

Read these workspace files before answering:
- run config and market facts: ${params.configPath}
- executable family specs: ${params.familiesPath}
- prior history summary: ${params.historyPath}
- response schema: ${params.schemaPath}

Instructions:
- Use only the listed block families and their parameter names.
- Return 1 to ${params.candidatesPerIteration} executable candidates.
- Use the history summary to avoid repeated dead ends and to widen or tighten parameters when evidence supports it.
- Return JSON only that matches the schema file exactly.
- Do not emit markdown.
`.trim();
}

function buildBlockReviewFilePrompt(params: {
  configPath: string;
  familiesPath: string;
  proposalPath: string;
  evaluationsPath: string;
  historyPath: string;
  schemaPath: string;
  candidatesPerIteration: number;
}): string {
  return `
You are reviewing a BLOCK-level crypto strategy research iteration.

Read these workspace files before answering:
- run config: ${params.configPath}
- executable family specs: ${params.familiesPath}
- latest proposal batch: ${params.proposalPath}
- latest evaluation results: ${params.evaluationsPath}
- prior history summary: ${params.historyPath}
- response schema: ${params.schemaPath}

Instructions:
- Base the review on the files above.
- Choose "keep_searching" only when you can provide 1 to ${params.candidatesPerIteration} unique, executable nextCandidates.
- Choose "stop_no_edge" when you do not want to provide a next candidate batch.
- Return JSON only that matches the schema file exactly.
- Do not emit markdown.
`.trim();
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
    const composition: ProposedStrategyFamily["composition"] = (() => {
      if (!record.composition || typeof record.composition !== "object" || Array.isArray(record.composition)) {
        return undefined;
      }

      const value = asRecord(record.composition);
      const mode = value.mode === "weighted_vote" || value.mode === "confirmatory" ? value.mode : undefined;
      if (!mode) {
        return undefined;
      }

      const components = Array.isArray(value.components)
        ? value.components.flatMap((component) => {
            if (!component || typeof component !== "object" || Array.isArray(component)) {
              return [];
            }

            const item = asRecord(component);
            const familyId = String(item.familyId ?? "").trim();
            if (!familyId) {
              return [];
            }

            const parameterBindings =
              item.parameterBindings && typeof item.parameterBindings === "object" && !Array.isArray(item.parameterBindings)
                ? Object.fromEntries(
                    Object.entries(asRecord(item.parameterBindings))
                      .filter(([, value]) => typeof value === "string")
                      .map(([key, value]) => [key, String(value)])
                  )
                : {};

            return [{
              familyId,
              weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined,
              parameterBindings
            }];
          })
        : [];

      if (components.length === 0) {
        return undefined;
      }

      return {
        mode,
        buyThreshold: Number.isFinite(Number(value.buyThreshold)) ? Number(value.buyThreshold) : undefined,
        sellThreshold: Number.isFinite(Number(value.sellThreshold)) ? Number(value.sellThreshold) : undefined,
        components
      } satisfies NonNullable<ProposedStrategyFamily["composition"]>;
    })();

    if (!familyId || (parameterSpecs.length === 0 && !composition)) {
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
      composition,
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
      familyId: typeof record.familyId === "string" ? record.familyId : undefined,
      strategyName: typeof record.strategyName === "string" ? record.strategyName : undefined,
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

export class CliResearchLlmClient implements ResearchLlmClient {
  constructor(
    private readonly options: {
      provider?: string;
      model?: string;
      cwd?: string;
      jsonRunner?: typeof llmJson;
      textRunner?: typeof llmText;
    }
  ) {}

  private buildCliLlmOptions(config: AutoResearchRunConfig) {
    const timeoutMs = config.llmTimeoutMs;
    const provider = this.options.provider ?? config.llmProvider;
    const model = this.options.model ?? config.llmModel ?? (provider === "codex" ? "medium" : undefined);

    return {
      provider,
      model,
      cwd: this.options.cwd,
      timeoutMs,
      // Total wall-clock timeout matters more here than stdout-idle detection.
      // Codex emits progress and startup details on stderr, so an idle budget can
      // misclassify active work as a hang.
      idleTimeoutMs: undefined,
      hardTimeoutMs: typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs + 1_500 : undefined
    };
  }

  private shouldUseWorkspaceFilePrompts(config: AutoResearchRunConfig): boolean {
    const provider = this.options.provider ?? config.llmProvider ?? "codex";
    return provider === "codex";
  }

  private async runJsonPrompt(params: {
    prompt: string;
    config: AutoResearchRunConfig;
    rawResponsePath?: string;
  }): Promise<{
    data: unknown;
    tokenUsage?: {
      input: number;
      output: number;
    };
  }> {
    const options = this.buildCliLlmOptions(params.config);

    if (this.options.jsonRunner) {
      return await this.options.jsonRunner(params.prompt, options);
    }

    const { text, tokenUsage } = await (this.options.textRunner ?? llmText)(params.prompt, options);
    if (params.rawResponsePath) {
      await writeArtifactFile(params.rawResponsePath, `${text}\n`);
    }

    return {
      data: extractJson(text),
      tokenUsage
    };
  }

  private async buildBlockProposalPromptArtifacts(params: {
    config: AutoResearchRunConfig;
    families: StrategyFamilyDefinition[];
    marketCodes: string[];
    history: ResearchIterationRecord[];
  }): Promise<{
    prompt: string;
    schemaPath: string;
    rawResponsePath: string;
  }> {
    const iteration = params.history.length + 1;
    const contextDir = path.join(
      params.config.outputDir,
      `iteration-${String(iteration).padStart(2, "0")}`,
      "llm-proposal"
    );
    const configPath = path.join(contextDir, "run-config.json");
    const familiesPath = path.join(contextDir, "families.json");
    const historyPath = path.join(contextDir, "history-summary.json");
    const schemaPath = path.join(contextDir, "response-schema.json");
    const promptPath = path.join(contextDir, "prompt.txt");
    const rawResponsePath = path.join(contextDir, "response.raw.txt");

    await writeJsonArtifact(configPath, {
      config: {
        universe: params.config.universeName,
        timeframe: params.config.timeframe,
        marketLimit: params.config.marketLimit,
        limit: params.config.limit,
        holdoutDays: params.config.holdoutDays,
        trainingDays: params.config.trainingDays,
        stepDays: params.config.stepDays,
        mode: params.config.mode,
        researchStage: "block",
        candidatesPerIteration: params.config.candidatesPerIteration
      },
      marketCodes: params.marketCodes
    });
    await writeJsonArtifact(familiesPath, compactFamilies(params.families));
    await writeJsonArtifact(historyPath, blockHistorySummary(params.history));
    await writeJsonArtifact(schemaPath, buildBlockProposalResponseSchema());

    const prompt = buildBlockProposalFilePrompt({
      configPath,
      familiesPath,
      historyPath,
      schemaPath,
      candidatesPerIteration: params.config.candidatesPerIteration
    });
    await writeArtifactFile(promptPath, `${prompt}\n`);

    return {
      prompt,
      schemaPath,
      rawResponsePath
    };
  }

  private async buildBlockReviewPromptArtifacts(params: {
    config: AutoResearchRunConfig;
    families: StrategyFamilyDefinition[];
    history: ResearchIterationRecord[];
    latestProposal: ProposalBatch;
    preparationResults: PreparationExecutionResult[];
    codeMutationResults: Array<{
      taskId: string;
      familyId?: string;
      strategyName?: string;
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
  }): Promise<{
    prompt: string;
    schemaPath: string;
    rawResponsePath: string;
  }> {
    const iteration = params.history.length + 1;
    const contextDir = path.join(
      params.config.outputDir,
      `iteration-${String(iteration).padStart(2, "0")}`,
      "llm-review"
    );
    const configPath = path.join(contextDir, "run-config.json");
    const familiesPath = path.join(contextDir, "families.json");
    const proposalPath = path.join(contextDir, "latest-proposal.json");
    const evaluationsPath = path.join(contextDir, "latest-evaluations.json");
    const historyPath = path.join(contextDir, "history-summary.json");
    const schemaPath = path.join(contextDir, "response-schema.json");
    const promptPath = path.join(contextDir, "prompt.txt");
    const rawResponsePath = path.join(contextDir, "response.raw.txt");

    await writeJsonArtifact(configPath, {
      config: {
        universe: params.config.universeName,
        timeframe: params.config.timeframe,
        marketLimit: params.config.marketLimit,
        limit: params.config.limit,
        holdoutDays: params.config.holdoutDays,
        trainingDays: params.config.trainingDays,
        stepDays: params.config.stepDays,
        mode: params.config.mode,
        researchStage: "block",
        candidatesPerIteration: params.config.candidatesPerIteration
      },
      latestPreparationResults: compactPreparationResults(params.preparationResults),
      latestCodeMutationResults: compactCodeMutationResults(params.codeMutationResults),
      latestValidationResults: params.validationResults
    });
    await writeJsonArtifact(familiesPath, compactFamilies(params.families));
    await writeJsonArtifact(proposalPath, {
      researchSummary: params.latestProposal.researchSummary,
      preparation: params.latestProposal.preparation,
      candidates: params.latestProposal.candidates
    });
    await writeJsonArtifact(evaluationsPath, params.evaluations.map(compactEvaluation));
    await writeJsonArtifact(historyPath, blockHistorySummary(params.history));
    await writeJsonArtifact(schemaPath, buildBlockReviewResponseSchema());

    const prompt = buildBlockReviewFilePrompt({
      configPath,
      familiesPath,
      proposalPath,
      evaluationsPath,
      historyPath,
      schemaPath,
      candidatesPerIteration: params.config.candidatesPerIteration
    });
    await writeArtifactFile(promptPath, `${prompt}\n`);

    return {
      prompt,
      schemaPath,
      rawResponsePath
    };
  }

  async proposeCandidates(params: {
    config: AutoResearchRunConfig;
    families: StrategyFamilyDefinition[];
    marketCodes: string[];
    history: ResearchIterationRecord[];
    blockCatalog?: ValidatedBlockCatalog;
  }): Promise<ProposalBatch> {
    const promptArtifacts =
      params.config.researchStage === "block" && this.shouldUseWorkspaceFilePrompts(params.config)
        ? await this.buildBlockProposalPromptArtifacts(params)
        : undefined;
    const prompt =
      promptArtifacts?.prompt ??
      (params.config.researchStage === "block"
        ? buildBlockProposalPrompt({
            ...params,
            previousDiagnosis: params.history.length > 0
              ? { summary: params.history[params.history.length - 1]!.review.summary, observations: params.history[params.history.length - 1]!.review.observations }
              : undefined
          })
        : params.config.researchStage === "portfolio" && params.blockCatalog
          ? buildPortfolioCompositionProposalPrompt({ ...params, blockCatalog: params.blockCatalog })
          : buildProposalPrompt(params));
    let data: unknown;
    try {
      ({ data } = await this.runJsonPrompt({
        prompt,
        config: params.config,
        rawResponsePath: promptArtifacts?.rawResponsePath
      }));
    } catch (error) {
      if (
        promptArtifacts &&
        error instanceof Error &&
        /Failed to extract JSON from LLM response/.test(error.message)
      ) {
        const repairPrompt = buildJsonExtractionRepairPrompt({
          originalPrompt: prompt,
          invalidResponsePath: promptArtifacts.rawResponsePath,
          schemaPath: promptArtifacts.schemaPath
        });
        ({ data } = await this.runJsonPrompt({
          prompt: repairPrompt,
          config: params.config,
          rawResponsePath: path.join(path.dirname(promptArtifacts.rawResponsePath), "response.repaired.raw.txt")
        }));
      } else {
        throw error;
      }
    }
    const response = unwrapEnvelopeRecord(
      data,
      ["proposal", "result", "payload", "response"],
      (record) => Array.isArray(record.candidates)
    );

    return {
      researchSummary: String(response.researchSummary ?? "").trim(),
      preparation: parsePreparation(response.preparation),
      proposedFamilies: parseProposedFamilies(response.proposedFamilies),
      codeTasks: parseCodeTasks(response.codeTasks),
      candidates: parseCandidates(response.candidates, response)
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
      familyId?: string;
      strategyName?: string;
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
    blockCatalog?: ValidatedBlockCatalog;
  }): Promise<ReviewDecision> {
    const promptArtifacts =
      params.config.researchStage === "block" && this.shouldUseWorkspaceFilePrompts(params.config)
        ? await this.buildBlockReviewPromptArtifacts(params)
        : undefined;
    const prompt =
      promptArtifacts?.prompt ??
      (params.config.researchStage === "block"
        ? buildBlockReviewPrompt(params)
        : params.config.researchStage === "portfolio" && params.blockCatalog
          ? buildPortfolioCompositionReviewPrompt({ ...params, blockCatalog: params.blockCatalog })
          : buildReviewPrompt(params));
    const parseReview = (response: Record<string, unknown>): ReviewDecision => {
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
        nextCandidates: parseCandidates(response.nextCandidates ?? [], response),
        retireCandidateIds: Array.isArray(response.retireCandidateIds)
          ? response.retireCandidateIds.filter((value): value is string => typeof value === "string")
          : [],
        observations: Array.isArray(response.observations)
          ? response.observations.filter((value): value is string => typeof value === "string")
          : []
      };
    };
    const unwrapReview = (data: unknown) =>
      unwrapEnvelopeRecord(
        data,
        ["review", "result", "payload", "response"],
        (record) =>
          record.verdict === "keep_searching" ||
          record.verdict === "promote_candidate" ||
          record.verdict === "stop_no_edge"
      );

    let data: unknown;
    try {
      ({ data } = await this.runJsonPrompt({
        prompt,
        config: params.config,
        rawResponsePath: promptArtifacts?.rawResponsePath
      }));
    } catch (error) {
      if (
        promptArtifacts &&
        error instanceof Error &&
        /Failed to extract JSON from LLM response/.test(error.message)
      ) {
        const repairPrompt = buildJsonExtractionRepairPrompt({
          originalPrompt: prompt,
          invalidResponsePath: promptArtifacts.rawResponsePath,
          schemaPath: promptArtifacts.schemaPath
        });
        ({ data } = await this.runJsonPrompt({
          prompt: repairPrompt,
          config: params.config,
          rawResponsePath: path.join(path.dirname(promptArtifacts.rawResponsePath), "response.repaired.raw.txt")
        }));
      } else {
        throw error;
      }
    }
    let response = unwrapReview(data);
    let review = parseReview(response);

    if (review.verdict === "keep_searching" && review.nextCandidates.length === 0) {
      const repairPrompt = buildKeepSearchingRepairPrompt({
        originalPrompt: prompt,
        invalidResponse: response,
        candidatesPerIteration: params.config.candidatesPerIteration
      });
      const repair = await this.runJsonPrompt({
        prompt: repairPrompt,
        config: params.config,
        rawResponsePath: promptArtifacts
          ? path.join(path.dirname(promptArtifacts.rawResponsePath), "keep-searching-repair.raw.txt")
          : undefined
      });
      response = unwrapReview(repair.data);
      review = parseReview(response);

      if (review.verdict === "keep_searching" && review.nextCandidates.length === 0) {
        throw new Error("Invalid review decision: keep_searching requires at least 1 next candidate");
      }
    }

    return review;
  }
}
