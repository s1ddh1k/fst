import { mkdir, writeFile } from "node:fs/promises";
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
