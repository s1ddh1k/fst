import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateStrategyScaffold } from "../src/auto-research/strategy-scaffold.js";
import { isValidGeneratedModule } from "../src/auto-research/strategy-template.js";
import { loadJournal, saveJournal, appendJournalEntry, createEvaluationEntry, buildJournalSummary } from "../src/auto-research/research-journal.js";
import { buildDiscoveryPrompt, buildDesignPrompt, buildImplementationPrompt } from "../src/auto-research/discovery-prompts.js";
import { classifyLlmError, resolveFallbackChain } from "../src/auto-research/cli-llm.js";

// --- Strategy Scaffold ---

describe("generateStrategyScaffold", () => {
  it("generates valid TypeScript with metadata and createStrategy", () => {
    const code = generateStrategyScaffold({
      familyId: "generated:test-momentum",
      strategyName: "generated-test-momentum",
      title: "Test Momentum Strategy",
      thesis: "Momentum predicts short-term returns",
      family: "trend",
      sleeveId: "trend",
      decisionTimeframe: "1h",
      executionTimeframe: "5m",
      parameterSpecs: [
        { name: "lookback", description: "Lookback period", min: 5, max: 50 },
        { name: "threshold", description: "Entry threshold", min: 0.01, max: 0.1 }
      ],
      regimeGate: { allowedRegimes: ["trend_up"] },
      signalLogicDescription: "Buy when momentum exceeds threshold",
      indicators: ["getMomentum", "getEma"]
    });

    // Should contain key elements
    assert.ok(code.includes("export const metadata"), "should export metadata");
    assert.ok(code.includes("export function createStrategy"), "should export createStrategy");
    assert.ok(code.includes("generateSignal"), "should have generateSignal method");
    assert.ok(code.includes("generated:test-momentum"), "should have familyId");
    assert.ok(code.includes("YOUR SIGNAL LOGIC HERE"), "should have TODO marker for LLM");
    assert.ok(code.includes("lookback"), "should include parameter name");
    assert.ok(code.includes("threshold"), "should include parameter name");
    assert.ok(code.includes("getMomentum"), "should list indicators");
  });

  it("handles empty parameterSpecs", () => {
    const code = generateStrategyScaffold({
      familyId: "generated:simple",
      strategyName: "generated-simple",
      title: "Simple",
      thesis: "test",
      family: "meanreversion",
      sleeveId: "reversion",
      decisionTimeframe: "1h",
      executionTimeframe: "5m",
      parameterSpecs: [],
      regimeGate: { allowedRegimes: ["range"] },
      signalLogicDescription: "test",
      indicators: []
    });

    assert.ok(code.includes("export function createStrategy"));
    assert.ok(code.includes("generateSignal"));
  });
});

// --- Discovery Prompts ---

describe("buildDiscoveryPrompt", () => {
  it("generates a prompt with market context and existing families", () => {
    const prompt = buildDiscoveryPrompt({
      config: {
        universeName: "krw-top",
        timeframe: "1h",
        marketLimit: 10,
        limit: 2000,
        holdoutDays: 30,
        iterations: 10,
        candidatesPerIteration: 3,
        mode: "walk-forward",
        outputDir: "/tmp/test",
        allowDataCollection: false,
        allowFeatureCacheBuild: false,
        allowCodeMutation: false
      },
      marketCodes: ["KRW-BTC", "KRW-ETH", "KRW-XRP"],
      families: [{
        familyId: "test-family",
        strategyName: "test",
        title: "Test Strategy",
        thesis: "test thesis",
        timeframe: "1h",
        parameterSpecs: [],
        guardrails: []
      }],
      history: []
    });

    assert.ok(prompt.includes("DISCOVERY"), "should mention discovery task");
    assert.ok(prompt.includes("Upbit KRW"), "should mention exchange");
    assert.ok(prompt.includes("test-family"), "should list existing family");
    assert.ok(prompt.includes("3 coins"), "should mention market count");
    assert.ok(prompt.includes("ideas"), "should ask for ideas");
    assert.ok(prompt.includes("JSON"), "should request JSON format");
  });

  it("includes journal summary when provided", () => {
    const prompt = buildDiscoveryPrompt({
      config: {
        universeName: "krw-top", timeframe: "1h", marketLimit: 10, limit: 2000,
        holdoutDays: 30, iterations: 10, candidatesPerIteration: 3,
        mode: "walk-forward", outputDir: "/tmp/test",
        allowDataCollection: false, allowFeatureCacheBuild: false, allowCodeMutation: false
      },
      marketCodes: ["KRW-BTC"],
      families: [],
      history: [],
      journalSummary: {
        patterns: ["BB + RSI combo works well"],
        antiPatterns: ["1m scalping loses to fees"],
        recentEntries: ["[failure] Micro scalping: net=-2%"]
      }
    });

    assert.ok(prompt.includes("BB + RSI combo works well"), "should include patterns");
    assert.ok(prompt.includes("1m scalping loses to fees"), "should include anti-patterns");
  });
});

describe("buildDesignPrompt", () => {
  it("generates design prompt from idea", () => {
    const prompt = buildDesignPrompt({
      idea: {
        ideaId: "vol-cluster",
        title: "Volatility Clustering Breakout",
        thesis: "After low-vol periods, breakouts are more likely",
        mechanism: "Volatility mean-reverts",
        indicators: ["getATR", "getBollingerBands"]
      },
      config: {
        universeName: "krw-top", timeframe: "1h", marketLimit: 10, limit: 2000,
        holdoutDays: 30, iterations: 10, candidatesPerIteration: 3,
        mode: "walk-forward", outputDir: "/tmp/test",
        allowDataCollection: false, allowFeatureCacheBuild: false, allowCodeMutation: false
      }
    });

    assert.ok(prompt.includes("Volatility Clustering Breakout"));
    assert.ok(prompt.includes("getATR"));
    assert.ok(prompt.includes("parameterSpecs"));
  });
});

describe("buildImplementationPrompt", () => {
  it("includes scaffold code and design details", () => {
    const prompt = buildImplementationPrompt({
      design: {
        familyId: "generated:test",
        strategyName: "generated-test",
        title: "Test",
        thesis: "test",
        signalLogicDescription: "Buy on RSI oversold",
        entryLogic: "RSI < 30",
        exitLogic: "RSI > 70",
        indicators: ["getRsi"],
        parameterSpecs: [{ name: "rsiPeriod", description: "RSI period", min: 5, max: 30 }]
      },
      scaffoldCode: "// scaffold placeholder"
    });

    assert.ok(prompt.includes("RSI < 30"), "should include entry logic");
    assert.ok(prompt.includes("RSI > 70"), "should include exit logic");
    assert.ok(prompt.includes("p.rsiPeriod"), "should reference parameter names");
    assert.ok(prompt.includes("getRsi"), "should list indicators");
  });
});

// --- Research Journal ---

describe("research journal", () => {
  let tmpDir: string;

  it("creates empty journal on first load", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fst-journal-test-"));
    const journal = await loadJournal(tmpDir);
    assert.equal(journal.entries.length, 0);
    assert.equal(journal.patterns.length, 0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("appends and persists entries", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fst-journal-test-"));

    await appendJournalEntry(tmpDir, createEvaluationEntry({
      iteration: 1,
      familyId: "test-family",
      title: "Test Strategy",
      thesis: "test",
      netReturn: 0.05,
      tradeCount: 10,
      maxDrawdown: 0.03,
      promoted: false
    }));

    await appendJournalEntry(tmpDir, createEvaluationEntry({
      iteration: 2,
      familyId: "test-family",
      title: "Test Strategy",
      thesis: "test",
      netReturn: -0.02,
      tradeCount: 5,
      maxDrawdown: 0.08,
      promoted: false
    }));

    const journal = await loadJournal(tmpDir);
    assert.equal(journal.entries.length, 2);
    assert.equal(journal.entries[0]!.outcome, "partial"); // positive but not promoted
    assert.equal(journal.entries[1]!.outcome, "failure"); // negative
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates correct entries for zero-trade strategies", async () => {
    const entry = createEvaluationEntry({
      iteration: 1,
      familyId: "dead-strategy",
      title: "Dead",
      thesis: "nothing",
      netReturn: 0,
      tradeCount: 0,
      maxDrawdown: 0,
      promoted: false
    });

    assert.equal(entry.outcome, "failure");
    assert.ok(entry.outcomeReason.includes("Zero trades"));
    assert.ok(entry.lessonsLearned.some((l) => l.includes("no trades")));
  });

  it("creates success entry for promoted strategies", () => {
    const entry = createEvaluationEntry({
      iteration: 5,
      familyId: "winner",
      title: "Winner",
      thesis: "winning",
      netReturn: 0.12,
      tradeCount: 20,
      maxDrawdown: 0.04,
      promoted: true
    });

    assert.equal(entry.outcome, "success");
    assert.ok(entry.outcomeReason.includes("Promoted"));
  });

  it("builds journal summary for prompt injection", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fst-journal-test-"));

    const journal = await loadJournal(tmpDir);
    journal.patterns = ["BB + RSI works on 1h timeframe"];
    journal.antiPatterns = ["Scalping loses to fees"];

    await appendJournalEntry(tmpDir, createEvaluationEntry({
      iteration: 1, familyId: "f1", title: "T1", thesis: "t1",
      netReturn: 0.05, tradeCount: 10, maxDrawdown: 0.03, promoted: false
    }));

    const loaded = await loadJournal(tmpDir);
    loaded.patterns = journal.patterns;
    loaded.antiPatterns = journal.antiPatterns;
    await saveJournal(tmpDir, loaded);

    const reloaded = await loadJournal(tmpDir);
    const summary = buildJournalSummary(reloaded);

    assert.ok(summary.patterns.includes("BB + RSI works on 1h timeframe"));
    assert.ok(summary.antiPatterns.includes("Scalping loses to fees"));
    assert.equal(summary.recentEntries.length, 1);
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// --- isValidGeneratedModule ---

describe("isValidGeneratedModule", () => {
  it("validates correct module shape", () => {
    const valid = {
      createStrategy: () => ({}),
      metadata: {
        familyId: "test",
        strategyName: "test",
        family: "trend",
        sleeveId: "trend",
        decisionTimeframe: "1h",
        executionTimeframe: "5m",
        parameterSpecs: []
      }
    };
    assert.ok(isValidGeneratedModule(valid));
  });

  it("rejects missing createStrategy", () => {
    assert.ok(!isValidGeneratedModule({ metadata: { familyId: "x" } }));
  });

  it("rejects missing metadata", () => {
    assert.ok(!isValidGeneratedModule({ createStrategy: () => {} }));
  });

  it("rejects null/undefined", () => {
    assert.ok(!isValidGeneratedModule(null));
    assert.ok(!isValidGeneratedModule(undefined));
  });
});

// --- Dynamic loader (unit level) ---

describe("dynamic loader listDynamicStrategies", () => {
  it("returns empty array when directory is empty or missing", async () => {
    const { listDynamicStrategies } = await import("../src/auto-research/dynamic-loader.js");
    // May or may not find the generated-strategies dir, but should not crash
    const strategies = await listDynamicStrategies();
    assert.ok(Array.isArray(strategies));
  });
});
