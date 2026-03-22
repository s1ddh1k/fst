import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeDb as closeResearchDb,
  replaceStrategyRegimes
} from "../../../research/backtester/src/db.js";
import {
  closeDb as closePaperDb,
  listActiveStrategyRegimeSnapshots,
  loadActiveStrategyRegimes
} from "../src/db.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function withTempSqliteDb(run: (params: { artifactDir: string }) => Promise<void>): Promise<void> {
  await closeResearchDb();
  await closePaperDb();

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "fst-paper-verified-"));
  const previous = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(tempDir, "test.db");

  try {
    await run({
      artifactDir: path.join(tempDir, "artifact")
    });
  } finally {
    await closeResearchDb();
    await closePaperDb();
    if (previous === undefined) {
      delete process.env.SQLITE_PATH;
    } else {
      process.env.SQLITE_PATH = previous;
    }
  }
}

test("paper trader only exposes verified recommendations", async () => {
  await withTempSqliteDb(async ({ artifactDir }) => {
    await writeJson(path.join(artifactDir, "status.json"), {
      phase: "completed",
      verification: {
        artifactAudit: {
          ok: true
        }
      }
    });
    await writeJson(path.join(artifactDir, "report.json"), {
      outcome: "completed",
      verification: {
        artifactAudit: {
          ok: true
        }
      }
    });
    await writeJson(path.join(artifactDir, "artifact-audit.json"), {
      ok: true
    });

    await replaceStrategyRegimes({
      regimeName: "walk-forward-recommendation",
      universeName: "krw-top",
      timeframe: "1h",
      holdoutDays: 90,
      verification: {
        kind: "auto_research",
        outputDir: artifactDir
      },
      metadata: {
        sourceLabel: "verified-test"
      },
      rows: [
        {
          strategyType: "single",
          strategyNames: ["relative-momentum-pullback"],
          parameters: { lookback: 20 },
          weights: [],
          marketCount: 5,
          avgTrainReturn: 0.12,
          avgTestReturn: 0.08,
          avgTestDrawdown: 0.04,
          rank: 1
        }
      ]
    });

    await replaceStrategyRegimes({
      regimeName: "paper-trading-candidate",
      universeName: "krw-top",
      timeframe: "1h",
      holdoutDays: 90,
      verification: {
        kind: "unsafe_override",
        reason: "test-only"
      },
      metadata: {
        sourceLabel: "unsafe-test"
      },
      rows: [
        {
          strategyType: "single",
          strategyNames: ["relative-momentum-pullback"],
          parameters: { lookback: 10 },
          weights: [],
          marketCount: 5,
          avgTrainReturn: 0.05,
          avgTestReturn: 0.02,
          avgTestDrawdown: 0.03,
          rank: 1
        }
      ]
    });

    const verifiedRows = await loadActiveStrategyRegimes({
      regimeName: "walk-forward-recommendation",
      universeName: "krw-top",
      timeframe: "1h",
      limit: 5
    });
    const unsafeRows = await loadActiveStrategyRegimes({
      regimeName: "paper-trading-candidate",
      universeName: "krw-top",
      timeframe: "1h",
      limit: 5
    });
    const snapshots = await listActiveStrategyRegimeSnapshots(10);

    assert.equal(verifiedRows.length, 1);
    assert.equal(verifiedRows[0]?.strategyNames[0], "relative-momentum-pullback");
    assert.equal(unsafeRows.length, 0);
    assert.equal(
      snapshots.some((snapshot) => snapshot.regimeName === "walk-forward-recommendation"),
      true
    );
    assert.equal(
      snapshots.some((snapshot) => snapshot.regimeName === "paper-trading-candidate"),
      false
    );
  });
});
