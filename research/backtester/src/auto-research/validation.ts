import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ValidationCommandResult } from "./types.js";

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
        resolve(stdout.trim() || stderr.trim());
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `${command} ${args.join(" ")} failed`));
    });
  });
}

export async function runPostMutationValidation(params: {
  outputDir: string;
  cwd: string;
  enabled: boolean;
}): Promise<ValidationCommandResult[]> {
  await mkdir(params.outputDir, { recursive: true });

  const commands: Array<{ label: string; command: string; args: string[] }> = [
    {
      label: "backtester typecheck",
      command: "pnpm",
      args: ["--filter", "@fst/backtester", "typecheck"]
    },
    {
      label: "backtester tests",
      command: "pnpm",
      args: ["--filter", "@fst/backtester", "test"]
    }
  ];

  const results: ValidationCommandResult[] = [];

  for (const item of commands) {
    if (!params.enabled) {
      results.push({
        command: item.label,
        status: "skipped",
        detail: "Validation skipped because code mutation is disabled."
      });
      continue;
    }

    try {
      const detail = await runCommand(item.command, item.args, params.cwd);
      results.push({
        command: item.label,
        status: "passed",
        detail
      });
    } catch (error) {
      results.push({
        command: item.label,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error)
      });
      break;
    }
  }

  await writeFile(
    path.join(params.outputDir, "validation-results.json"),
    `${JSON.stringify(results, null, 2)}\n`
  );

  return results;
}

export type StrategyValidationResult = {
  step: string;
  passed: boolean;
  detail: string;
};

export async function validateGeneratedStrategy(params: {
  filePath: string;
  cwd: string;
}): Promise<{ ok: boolean; results: StrategyValidationResult[] }> {
  const results: StrategyValidationResult[] = [];

  // Step 1: File exists
  try {
    await access(params.filePath);
    results.push({ step: "file_exists", passed: true, detail: params.filePath });
  } catch {
    results.push({ step: "file_exists", passed: false, detail: `File not found: ${params.filePath}` });
    return { ok: false, results };
  }

  // Step 2: Smoke test — import module in subprocess and validate shape
  // (skipping node --check which doesn't work with TypeScript)
  try {
    const smokeScript = `
      const rawMod = await import("file://${params.filePath}?t=" + Date.now());
      // tsx may wrap exports under .default
      const mod = rawMod.createStrategy ? rawMod : (rawMod.default ?? rawMod);
      const valid = typeof mod.createStrategy === "function" && mod.metadata != null;
      if (!valid) {
        process.stderr.write("Missing createStrategy or metadata. Keys: " + Object.keys(rawMod).join(","));
        process.exit(1);
      }
      const strategy = mod.createStrategy({ strategyId: "smoke-test", parameters: {} });
      if (!strategy || typeof strategy.generateSignal !== "function") {
        process.stderr.write("createStrategy did not return a valid Strategy object");
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({ id: strategy.id, family: strategy.family }));
    `;
    const output = await runCommand(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", smokeScript],
      params.cwd
    );
    results.push({ step: "smoke_test", passed: true, detail: output.slice(0, 200) });
  } catch (error) {
    results.push({ step: "smoke_test", passed: false, detail: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    return { ok: false, results };
  }

  return { ok: true, results };
}
