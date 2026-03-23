import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AutoResearchRunConfig, ResearchIterationRecord, StrategyFamilyDefinition } from "./types.js";
import { buildDiscoveryPrompt, buildDesignPrompt, buildImplementationPrompt } from "./discovery-prompts.js";
import { generateStrategyScaffold } from "./strategy-scaffold.js";
import { validateGeneratedStrategy } from "./validation.js";
import { llmJson, llmText } from "./cli-llm.js";
import { loadJournal, buildJournalSummary } from "./research-journal.js";

type DiscoveryIdea = {
  ideaId: string;
  title: string;
  thesis: string;
  mechanism: string;
  indicators: string[];
};

type DesignResult = {
  familyId?: string;
  strategyName?: string;
  title?: string;
  thesis?: string;
  family?: "trend" | "breakout" | "micro" | "meanreversion";
  sleeveId?: string;
  signalLogicDescription?: string;
  indicators?: string[];
  entryLogic?: string;
  exitLogic?: string;
  parameterSpecs?: Array<{ name: string; description: string; min: number; max: number }>;
  regimeGate?: { allowedRegimes: string[] };
};

export async function runDiscoveryCycle(params: {
  config: AutoResearchRunConfig;
  marketCodes: string[];
  runtimeFamilies: StrategyFamilyDefinition[];
  iterations: ResearchIterationRecord[];
  log: (msg: string) => Promise<void>;
}): Promise<{ newFamily?: StrategyFamilyDefinition }> {
  const { config, marketCodes, runtimeFamilies, iterations, log } = params;

  // Load journal for context
  let journalSummary: ReturnType<typeof buildJournalSummary> | undefined;
  try {
    const journal = await loadJournal(config.outputDir);
    journalSummary = buildJournalSummary(journal);
  } catch { /* not available yet */ }

  // Step 1: Discovery — get ideas from LLM
  const discoveryPrompt = buildDiscoveryPrompt({ config, marketCodes, families: runtimeFamilies, history: iterations, journalSummary });

  let ideas: DiscoveryIdea[] = [];
  try {
    const { data } = await llmJson(discoveryPrompt, { provider: config.llmProvider, model: config.llmModel, timeoutMs: config.llmTimeoutMs });
    if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).ideas)) {
      ideas = (data as { ideas: DiscoveryIdea[] }).ideas.filter((i) => i.ideaId && i.title);
    }
  } catch (error) {
    await log(`[auto-research] discovery LLM failed: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }

  if (ideas.length === 0) {
    await log("[auto-research] discovery returned no valid ideas");
    return {};
  }

  await log(`[auto-research] discovered ${ideas.length} ideas`);
  const generatedDir = path.join(process.cwd(), "src", "generated-strategies");
  await mkdir(generatedDir, { recursive: true });

  // Try each idea until one succeeds
  for (const idea of ideas) {
    await log(`[auto-research] trying idea: ${idea.title}`);

    try {
      // Step 2: Design
      const { data: designData } = await llmJson(
        buildDesignPrompt({ idea, config }),
        { provider: config.llmProvider, model: config.llmModel, timeoutMs: config.llmTimeoutMs }
      );
      if (!designData || typeof designData !== "object") continue;
      const design = designData as DesignResult;

      const familyId = design.familyId ?? `generated:${idea.ideaId}`;
      const safeName = (design.strategyName ?? `generated-${idea.ideaId}`).replace(/[^a-zA-Z0-9-]/g, "-");

      // Step 3: Scaffold + Implementation prompt
      const scaffold = generateStrategyScaffold({
        familyId, strategyName: safeName,
        title: design.title ?? idea.title, thesis: design.thesis ?? idea.thesis,
        family: design.family ?? "meanreversion", sleeveId: design.sleeveId ?? "reversion",
        decisionTimeframe: config.timeframe, executionTimeframe: "5m",
        parameterSpecs: design.parameterSpecs ?? [],
        regimeGate: design.regimeGate ?? { allowedRegimes: ["trend_up", "range"] },
        signalLogicDescription: design.signalLogicDescription ?? "",
        indicators: design.indicators ?? []
      });

      const implPrompt = buildImplementationPrompt({
        design: {
          familyId, strategyName: safeName,
          title: design.title ?? idea.title, thesis: design.thesis ?? idea.thesis,
          signalLogicDescription: design.signalLogicDescription ?? "",
          entryLogic: design.entryLogic ?? "", exitLogic: design.exitLogic ?? "",
          indicators: design.indicators ?? [], parameterSpecs: design.parameterSpecs ?? []
        },
        scaffoldCode: scaffold
      });

      // Step 4: Get signal logic (short prompt, tools disabled)
      const { text: signalBody } = await llmText(implPrompt, { provider: "claude", timeoutMs: 60_000, allowTools: "" });
      if (!signalBody || signalBody.length < 20) {
        await log(`[auto-research] idea ${idea.ideaId}: signal logic too short`);
        continue;
      }

      // Extract code, inject into scaffold
      const codeMatch = signalBody.match(/```(?:typescript|ts)?\s*\n([\s\S]*?)\n```/);
      const finalCode = scaffold.replace(/\/\/ --- YOUR SIGNAL LOGIC HERE ---/, codeMatch ? codeMatch[1]! : signalBody.trim());

      // Step 5: Write + Validate
      const strategyPath = path.join(generatedDir, `${safeName}.ts`);
      await writeFile(strategyPath, finalCode);

      const validation = await validateGeneratedStrategy({ filePath: strategyPath, cwd: process.cwd() });
      if (validation.ok) {
        await log(`[auto-research] strategy validated: ${safeName}`);
        return {
          newFamily: {
            familyId, strategyName: safeName,
            title: design.title ?? idea.title, thesis: design.thesis ?? idea.thesis,
            timeframe: config.timeframe as "1h" | "15m" | "5m" | "1m",
            parameterSpecs: design.parameterSpecs ?? [], guardrails: []
          }
        };
      }

      await log(`[auto-research] validation failed for ${safeName}: ${validation.results.map((r) => `${r.step}=${r.passed}`).join(", ")}`);
      try { await rm(strategyPath); } catch { /* cleanup */ }
    } catch (error) {
      await log(`[auto-research] idea ${idea.ideaId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {};
}
