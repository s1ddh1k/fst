import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildMarketFeaturePipeline } from "../market-feature-pipeline.js";
import { createScoredStrategyByName } from "../strategy-registry.js";
import type { ResearchPreparationAction, PreparationExecutionResult } from "./types.js";

function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || `${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

export async function executePreparationActions(params: {
  outputDir: string;
  actions: ResearchPreparationAction[];
  marketCodes: string[];
  universeName: string;
  defaultLimit: number;
  defaultMinCandles: number;
  allowDataCollection: boolean;
  allowFeatureCacheBuild: boolean;
}): Promise<PreparationExecutionResult[]> {
  await mkdir(params.outputDir, { recursive: true });

  const results: PreparationExecutionResult[] = [];

  for (const action of params.actions) {
    try {
      if (action.kind === "build_feature_cache") {
        if (!params.allowFeatureCacheBuild) {
          results.push({
            action,
            status: "skipped",
            detail: "Feature cache build disabled by config."
          });
          continue;
        }

        const strategy = action.familyId
          ? createScoredStrategyByName(action.familyId)
          : undefined;
        const summary = await buildMarketFeaturePipeline({
          universeName: params.universeName,
          timeframe: action.timeframe,
          marketCodes: params.marketCodes.slice(0, action.marketLimit ?? params.marketCodes.length),
          limit: action.limit ?? params.defaultLimit,
          minCandles: action.minCandles ?? params.defaultMinCandles,
          config: strategy?.contextConfig
        });

        results.push({
          action,
          status: "executed",
          detail: JSON.stringify(summary)
        });
        continue;
      }

      if (!params.allowDataCollection) {
        results.push({
          action,
          status: "skipped",
          detail: "Data collection disabled by config."
        });
        continue;
      }

      const markets = (action.markets && action.markets.length > 0 ? action.markets : params.marketCodes).join(",");

      if (action.kind === "sync_latest_batch") {
        const stdout = await runCommand(
          "pnpm",
          [
            "--filter",
            "@fst/data-collector",
            "dev",
            "sync-latest-batch",
            "--markets",
            markets,
            "--timeframes",
            action.timeframes.join(",")
          ],
          path.resolve(process.cwd())
        );
        results.push({ action, status: "executed", detail: stdout });
        continue;
      }

      const stdout = await runCommand(
        "pnpm",
        [
          "--filter",
          "@fst/data-collector",
          "dev",
          "backfill-batch",
          "--markets",
          markets,
          "--timeframes",
          action.timeframes.join(","),
          "--pages",
          String(action.pages)
        ],
        path.resolve(process.cwd())
      );
      results.push({ action, status: "executed", detail: stdout });
    } catch (error) {
      results.push({
        action,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await writeFile(
    path.join(params.outputDir, "preparation-results.json"),
    `${JSON.stringify(results, null, 2)}\n`
  );

  return results;
}
