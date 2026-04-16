import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBenchmarkPack,
  createBacktesterBenchmarkPack,
  runBenchmarkPack,
  runBoundedCommand
} from "../src/auto-research/benchmark-pack.js";
import {
  extractAutoResearchMetricSnapshot,
  renderAutoResearchMetricLines
} from "../src/auto-research/code-mutation-benchmark.js";
import type { CandidateBacktestEvaluation } from "../src/auto-research/types.js";

function buildWalkForwardEvaluation(): CandidateBacktestEvaluation {
  return {
    candidate: {
      candidateId: "wf-01",
      familyId: "relative-momentum-pullback",
      strategyName: "relative-momentum-pullback",
      thesis: "wf",
      parameters: {
        minStrengthPct: 0.8
      },
      invalidationSignals: []
    },
    mode: "walk-forward",
    status: "completed",
    summary: {
      totalReturn: 0.08,
      grossReturn: 0.09,
      netReturn: 0.08,
      maxDrawdown: 0.05,
      turnover: 0.2,
      winRate: 0.5,
      avgHoldBars: 10,
      tradeCount: 3.5,
      feePaid: 10,
      slippagePaid: 8,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 0,
      signalCount: 20,
      ghostSignalCount: 5,
      bootstrapSignificant: true,
      randomPercentile: 0.84,
      buyAndHoldReturn: 0.03
    },
    diagnostics: {
      coverage: {
        tradeCount: 14,
        signalCount: 20,
        ghostSignalCount: 5,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0,
        rawBuySignals: 8,
        rawSellSignals: 3,
        rawHoldSignals: 9,
        avgUniverseSize: 5,
        minUniverseSize: 4,
        maxUniverseSize: 6,
        avgConsideredBuys: 1.2,
        avgEligibleBuys: 0.7
      },
      reasons: {
        strategy: {},
        strategyTags: {},
        coordinator: {},
        execution: {},
        risk: {}
      },
      costs: {
        feePaid: 10,
        slippagePaid: 8,
        totalCostsPaid: 18
      },
      robustness: {
        bootstrapSignificant: true,
        randomPercentile: 0.84
      },
      crossChecks: [],
      windows: {
        mode: "walk-forward",
        holdoutDays: 90,
        trainingDays: 180,
        stepDays: 90,
        windowCount: 4,
        positiveWindowCount: 3,
        positiveWindowRatio: 0.75,
        negativeWindowCount: 1,
        bestWindowNetReturn: 0.12,
        worstWindowNetReturn: -0.01,
        bestWindowMaxDrawdown: 0.02,
        worstWindowMaxDrawdown: 0.23,
        totalClosedTrades: 14
      }
    }
  };
}

test("runBoundedCommand returns passed for a successful command", async () => {
  const result = await runBoundedCommand(
    {
      label: "echo",
      command: "echo ok",
      timeoutMs: 5_000
    },
    process.cwd()
  );

  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  assert.match(result.detail, /ok/);
  assert.deepEqual(result.metrics, {});
});

test("runBoundedCommand returns timed_out for a long-running command", async () => {
  const result = await runBoundedCommand(
    {
      label: "sleep",
      command: "sleep 5",
      timeoutMs: 50
    },
    process.cwd()
  );

  assert.equal(result.status, "timed_out");
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.metrics, {});
});

test("runBoundedCommand parses METRIC lines from stdout and stderr", async () => {
  const result = await runBoundedCommand(
    {
      label: "emit metrics",
      command: "printf 'METRIC net_return=0.125\\nnoise\\n'; printf 'METRIC max_drawdown=0.04\\nMETRIC __proto__=7\\n' >&2",
      timeoutMs: 5_000
    },
    process.cwd()
  );

  assert.equal(result.status, "passed");
  assert.deepEqual(result.metrics, {
    net_return: 0.125,
    max_drawdown: 0.04
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result.metrics, "__proto__"), false);
});

test("runBenchmarkPack stops on failure and marks later commands skipped", async () => {
  const execution = await runBenchmarkPack({
    cwd: process.cwd(),
    pack: {
      packId: "sample",
      title: "Sample",
      stopOnFailure: true,
      commands: [
        {
          label: "fail",
          command: "exit 2",
          timeoutMs: 5_000
        },
        {
          label: "unreached",
          command: "echo later",
          timeoutMs: 5_000
        }
      ]
    }
  });

  assert.equal(execution.status, "failed");
  assert.equal(execution.commandStatus, "failed");
  assert.equal(execution.results[0]?.status, "failed");
  assert.equal(execution.results[1]?.status, "skipped");
  assert.equal(execution.summary.failed, 1);
  assert.equal(execution.summary.skipped, 1);
  assert.equal(execution.metricGateStatus, "not_configured");
  assert.deepEqual(execution.metrics, {});
});

test("runBenchmarkPack evaluates metric gates after commands pass", async () => {
  const execution = await runBenchmarkPack({
    cwd: process.cwd(),
    pack: {
      packId: "metric-gate",
      title: "Metric Gate",
      commands: [
        {
          label: "emit metric",
          command: "printf 'METRIC net_return=0.11\\n'",
          timeoutMs: 5_000
        }
      ],
      metricGates: [
        {
          metricName: "net_return",
          direction: "higher",
          baseline: 0.1,
          minDelta: 0.02
        }
      ]
    }
  });

  assert.equal(execution.commandStatus, "passed");
  assert.equal(execution.metricGateStatus, "failed");
  assert.equal(execution.status, "failed");
  assert.equal(execution.metricGateResults[0]?.status, "failed");
  assert.equal(execution.metricGateResults[0]?.requiredDelta, 0.02);
  assert.equal(execution.metrics.net_return, 0.11);
});

test("runBenchmarkPack aggregates the latest metric values and passes relative gates", async () => {
  const execution = await runBenchmarkPack({
    cwd: process.cwd(),
    pack: {
      packId: "metric-latest",
      title: "Metric Latest",
      commands: [
        {
          label: "first metric",
          command: "printf 'METRIC sharpe=1.0\\nMETRIC max_drawdown=0.08\\n'",
          timeoutMs: 5_000
        },
        {
          label: "second metric",
          command: "printf 'METRIC sharpe=1.3\\nMETRIC max_drawdown=0.05\\n'",
          timeoutMs: 5_000
        }
      ],
      metricGates: [
        {
          metricName: "sharpe",
          direction: "higher",
          baseline: 1.0,
          minRelativeDelta: 0.2
        },
        {
          metricName: "max_drawdown",
          direction: "lower",
          baseline: 0.08,
          minDelta: 0.02
        }
      ]
    }
  });

  assert.equal(execution.commandStatus, "passed");
  assert.equal(execution.metricGateStatus, "passed");
  assert.equal(execution.status, "passed");
  assert.deepEqual(execution.metrics, {
    sharpe: 1.3,
    max_drawdown: 0.05
  });
  assert.deepEqual(
    execution.metricGateResults.map((result) => result.status),
    ["passed", "passed"]
  );
});

test("auto research metric snapshot uses walk-forward aggregate semantics", () => {
  const snapshot = extractAutoResearchMetricSnapshot(buildWalkForwardEvaluation());

  assert.deepEqual(snapshot, {
    netReturn: 0.08,
    maxDrawdown: 0.23,
    tradeCount: 14,
    positiveWindowRatio: 0.75,
    randomPercentile: 0.84,
    buyHoldExcess: 0.05
  });
  assert.deepEqual(renderAutoResearchMetricLines(snapshot), [
    "METRIC net_return=0.08",
    "METRIC max_drawdown=0.23",
    "METRIC trade_count=14",
    "METRIC positive_window_ratio=0.75",
    "METRIC random_percentile=0.84",
    "METRIC buy_hold_excess=0.05"
  ]);
});

test("buildBenchmarkPack appends auto research performance benchmark and gates", () => {
  const pack = buildBenchmarkPack({
    repoRoot: "/tmp/fst-repo",
    task: {
      taskId: "fix-alpha",
      title: "Fix alpha regression",
      intent: "fix_bug",
      rationale: "preserve current champion performance",
      acceptanceCriteria: ["benchmark stays green"],
      targetFiles: ["research/backtester/src/alpha.ts"],
      prompt: "fix it"
    },
    performanceBenchmark: {
      payloadPath: "/tmp/benchmark-payload.json",
      evaluationOutputPath: "/tmp/benchmark-result.json",
      baselineMetrics: extractAutoResearchMetricSnapshot(buildWalkForwardEvaluation())
    }
  });

  assert.equal(pack.commands[pack.commands.length - 1]?.label, "auto-research performance benchmark");
  assert.match(pack.commands[pack.commands.length - 1]?.command ?? "", /code-mutation-benchmark\.ts/);
  assert.deepEqual(
    pack.metricGates?.map((gate) => gate.metricName),
    [
      "net_return",
      "max_drawdown",
      "trade_count",
      "positive_window_ratio",
      "random_percentile",
      "buy_hold_excess"
    ]
  );
});

test("createBacktesterBenchmarkPack builds typecheck and test commands", () => {
  const pack = createBacktesterBenchmarkPack();

  assert.equal(pack.packId, "backtester-typecheck-and-test");
  assert.deepEqual(
    pack.commands.map((command) => command.label),
    ["backtester typecheck", "backtester tests"]
  );
  assert.equal(pack.metricGates, undefined);
});
