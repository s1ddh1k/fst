import { spawn } from "node:child_process";

export async function discoverRuntimeScoredStrategyNames(cwd: string): Promise<string[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "--filter",
        "@fst/backtester",
        "exec",
        "tsx",
        "src/auto-research/runtime-discovery-worker.ts"
      ],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(out);
        return;
      }

      reject(new Error(err.trim() || out.trim() || `runtime discovery failed with code ${code}`));
    });
  });

  const parsed = JSON.parse(stdout) as { scoredStrategyNames?: string[] };
  return Array.isArray(parsed.scoredStrategyNames)
    ? parsed.scoredStrategyNames.filter((value): value is string => typeof value === "string")
    : [];
}
