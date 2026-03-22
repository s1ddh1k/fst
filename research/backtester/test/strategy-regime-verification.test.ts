import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStrategyRegimePublicationVerification } from "../src/strategy-regime-verification.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("auto research publication verification accepts completed audited runs", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-publish-verify-"));
  await writeJson(path.join(outputDir, "status.json"), {
    phase: "completed",
    verification: {
      artifactAudit: {
        ok: true
      }
    }
  });
  await writeJson(path.join(outputDir, "report.json"), {
    outcome: "completed",
    verification: {
      artifactAudit: {
        ok: true
      }
    }
  });
  await writeJson(path.join(outputDir, "artifact-audit.json"), {
    ok: true
  });

  const evidence = await resolveStrategyRegimePublicationVerification({
    kind: "auto_research",
    outputDir
  });

  assert.equal(evidence.status, "verified");
  assert.equal(evidence.sourceKind, "auto_research");
  assert.equal(evidence.outputDir, outputDir);
});

test("deterministic BB publication verification rejects missing replay pass", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-det-publish-verify-"));
  await writeJson(path.join(outputDir, "status.json"), {
    phase: "completed"
  });
  await writeJson(path.join(outputDir, "wrapper-status.json"), {
    phase: "completed"
  });
  await writeJson(path.join(outputDir, "audit.json"), {
    ok: true
  });
  await writeJson(path.join(outputDir, "replay-verification.json"), {
    ok: false
  });

  await assert.rejects(
    () =>
      resolveStrategyRegimePublicationVerification({
        kind: "deterministic_bb",
        outputDir
      }),
    /audit or replay verification failed/
  );
});
