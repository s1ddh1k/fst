import test from "node:test";
import assert from "node:assert/strict";
import {
  createBacktesterBenchmarkPack,
  runBenchmarkPack,
  runBoundedCommand
} from "../src/auto-research/benchmark-pack.js";

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
  assert.equal(execution.results[0]?.status, "failed");
  assert.equal(execution.results[1]?.status, "skipped");
  assert.equal(execution.summary.failed, 1);
  assert.equal(execution.summary.skipped, 1);
});

test("createBacktesterBenchmarkPack builds typecheck and test commands", () => {
  const pack = createBacktesterBenchmarkPack();

  assert.equal(pack.packId, "backtester-typecheck-and-test");
  assert.deepEqual(
    pack.commands.map((command) => command.label),
    ["backtester typecheck", "backtester tests"]
  );
});
