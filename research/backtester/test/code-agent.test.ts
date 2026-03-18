import test from "node:test";
import assert from "node:assert/strict";
import { auditMutationScope } from "../src/auto-research/code-agent.js";

test("auditMutationScope flags files outside the allowed mutation scope", () => {
  const audit = auditMutationScope({
    before: [
      { code: "M", path: "README.md" }
    ],
    after: [
      { code: "M", path: "README.md" },
      { code: "M", path: "research/backtester/src/auto-research/orchestrator.ts" },
      { code: "M", path: "packages/shared/src/execution.ts" }
    ],
    allowlist: [
      "research/backtester/src/auto-research/orchestrator.ts"
    ]
  });

  assert.deepEqual(audit.newOrChangedPaths, [
    "packages/shared/src/execution.ts",
    "research/backtester/src/auto-research/orchestrator.ts"
  ]);
  assert.deepEqual(audit.violations, ["packages/shared/src/execution.ts"]);
});
