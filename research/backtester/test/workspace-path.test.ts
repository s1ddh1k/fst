import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { findWorkspaceRoot, resolveWorkspaceRelativePath } from "../src/workspace-path.js";

test("findWorkspaceRoot resolves the monorepo root from package cwd", () => {
  const packageCwd = "/home/eugene/git/fst/research/backtester";
  assert.equal(findWorkspaceRoot(packageCwd), "/home/eugene/git/fst");
});

test("resolveWorkspaceRelativePath treats repo-style output paths as workspace-root relative", () => {
  const packageCwd = "/home/eugene/git/fst/research/backtester";
  assert.equal(
    resolveWorkspaceRelativePath("research/backtester/artifacts/auto-research/demo-run", packageCwd),
    "/home/eugene/git/fst/research/backtester/artifacts/auto-research/demo-run"
  );
});

test("resolveWorkspaceRelativePath keeps plain relative paths relative to cwd", () => {
  const packageCwd = "/home/eugene/git/fst/research/backtester";
  assert.equal(
    resolveWorkspaceRelativePath("artifacts/auto-research/demo-run", packageCwd),
    path.resolve(packageCwd, "artifacts/auto-research/demo-run")
  );
});
