import test from "node:test";
import assert from "node:assert/strict";
import { buildCommand, extractJson } from "../src/auto-research/cli-llm.js";

test("buildCommand builds codex exec command locally without external repo dependency", () => {
  const command = buildCommand({
    provider: "codex",
    model: "medium",
    cwd: "/tmp/fst"
  });

  assert.equal(command.cmd, "codex");
  assert.deepEqual(command.args, [
    "exec",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    "model_reasoning_effort=medium",
    "--cd",
    "/tmp/fst",
    "-"
  ]);
});

test("buildCommand builds claude stream-json command locally", () => {
  const command = buildCommand({
    provider: "claude",
    model: "sonnet",
    outputFormat: "stream-json",
    cwd: "/tmp/fst"
  });

  assert.equal(command.cmd, "claude");
  assert.deepEqual(command.args, [
    "-p",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "sonnet"
  ]);
  assert.equal(command.cwd, "/tmp/fst");
});

test("extractJson parses embedded JSON object", () => {
  const result = extractJson("prefix text\n{\"ok\":true,\"count\":3}\nmore text");
  assert.deepEqual(result, { ok: true, count: 3 });
});
