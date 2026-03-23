import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const KEEP_FILES = new Set([
  "run-state.json",
  "leaderboard.json",
  "raw-leaderboard.json",
  "family-summary.json",
  "candidate-ledger.json",
  "candidate-genealogy.json",
  "report.html",
  "report.json",
  "validated-blocks.json",
  "lineage.json",
  "research-lineage.json",
  "lineage-events.jsonl",
  "lineage-snapshot.json",
  "daemon-state.json",
  "daemon.jsonl",
  "heartbeat.json",
  "run.log",
  "status.json",
  "run.lock.json",
  "catalog.json"
]);

export type CleanupResult = {
  deletedCount: number;
  freedBytes: number;
  errors: string[];
};

export async function cleanIterationArtifacts(params: {
  outputDir: string;
  keepDays?: number;
  log?: (msg: string) => void;
}): Promise<CleanupResult> {
  const keepDays = params.keepDays ?? 3;
  const log = params.log ?? (() => {});
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const result: CleanupResult = { deletedCount: 0, freedBytes: 0, errors: [] };

  try {
    const entries = await readdir(params.outputDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Match iteration directories and LLM artifact directories
      if (!entry.name.startsWith("iteration-") && !entry.name.startsWith("evaluations")) continue;

      const dirPath = path.join(params.outputDir, entry.name);
      try {
        const dirStat = await stat(dirPath);
        if (dirStat.mtimeMs > cutoff) continue;

        // Delete individual evaluation JSON files inside
        const subEntries = await readdir(dirPath, { withFileTypes: true });
        for (const sub of subEntries) {
          const subPath = path.join(dirPath, sub.name);
          if (sub.isFile() && sub.name.endsWith(".json")) {
            try {
              const fileStat = await stat(subPath);
              await rm(subPath);
              result.deletedCount++;
              result.freedBytes += fileStat.size;
            } catch (e) {
              result.errors.push(`${subPath}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          // Recurse into subdirectories (e.g., llm-proposal/, llm-review/)
          if (sub.isDirectory()) {
            try {
              const nestedEntries = await readdir(subPath);
              for (const nested of nestedEntries) {
                if (nested === "prompt.txt") continue; // keep prompts for debugging
                const nestedPath = path.join(subPath, nested);
                try {
                  const nestedStat = await stat(nestedPath);
                  if (nestedStat.isFile()) {
                    await rm(nestedPath);
                    result.deletedCount++;
                    result.freedBytes += nestedStat.size;
                  }
                } catch (e) {
                  result.errors.push(`${nestedPath}: ${e instanceof Error ? e.message : String(e)}`);
                }
              }
            } catch { /* best effort */ }
          }
        }
      } catch (e) {
        result.errors.push(`${dirPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch { /* output dir might not exist yet */ }

  if (result.deletedCount > 0) {
    log(`[cleanup] deleted ${result.deletedCount} files, freed ${(result.freedBytes / 1024 / 1024).toFixed(1)}MB`);
  }

  return result;
}

export async function cleanStaleRuns(params: {
  parentDir: string;
  retentionDays?: number;
  log?: (msg: string) => void;
}): Promise<CleanupResult> {
  const retentionDays = params.retentionDays ?? 14;
  const log = params.log ?? (() => {});
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result: CleanupResult = { deletedCount: 0, freedBytes: 0, errors: [] };

  try {
    const entries = await readdir(params.parentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = path.join(params.parentDir, entry.name);

      try {
        const runStat = await stat(runDir);
        if (runStat.mtimeMs > cutoff) continue;

        // Delete everything except essential summary files
        const files = await readdir(runDir, { withFileTypes: true });
        for (const file of files) {
          const filePath = path.join(runDir, file.name);

          if (file.isFile() && KEEP_FILES.has(file.name)) continue;

          try {
            const fileStat = await stat(filePath);
            const size = fileStat.isDirectory() ? 0 : fileStat.size;
            await rm(filePath, { recursive: true, force: true });
            result.deletedCount++;
            result.freedBytes += size;
          } catch (e) {
            result.errors.push(`${filePath}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        result.errors.push(`${runDir}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch { /* parent dir might not exist */ }

  if (result.deletedCount > 0) {
    log(`[cleanup] stale runs: deleted ${result.deletedCount} items, freed ${(result.freedBytes / 1024 / 1024).toFixed(1)}MB`);
  }

  return result;
}
