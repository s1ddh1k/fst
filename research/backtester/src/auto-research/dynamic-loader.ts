import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isValidGeneratedModule, type GeneratedStrategyModule } from "./strategy-template.js";

const moduleCache = new Map<string, GeneratedStrategyModule>();

function findGeneratedStrategiesDir(): string {
  // Walk up from cwd to find research/backtester/src/generated-strategies
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "research", "backtester", "src", "generated-strategies");
    try {
      const { existsSync } = require("node:fs");
      if (existsSync(candidate)) return candidate;
    } catch {
      // fallback: just try the path
    }
    // Also check if we're inside research/backtester
    const localCandidate = path.join(dir, "src", "generated-strategies");
    try {
      const { existsSync } = require("node:fs");
      if (existsSync(localCandidate)) return localCandidate;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), "src", "generated-strategies");
}

export async function listDynamicStrategies(): Promise<string[]> {
  const dir = findGeneratedStrategiesDir();
  try {
    const entries = await readdir(dir);
    return entries
      .filter((e) => e.endsWith(".ts") && !e.startsWith(".") && !e.startsWith("_"))
      .map((e) => e.replace(/\.ts$/, ""));
  } catch {
    return [];
  }
}

export async function loadDynamicStrategy(familyId: string): Promise<GeneratedStrategyModule | null> {
  // Check cache
  if (moduleCache.has(familyId)) return moduleCache.get(familyId)!;

  const dir = findGeneratedStrategiesDir();
  // Try exact match, then sanitized match
  const candidates = [
    path.join(dir, `${familyId}.ts`),
    path.join(dir, `${familyId.replace(/^block:/, "")}.ts`),
    path.join(dir, `${familyId.replace(/[^a-zA-Z0-9-]/g, "-")}.ts`)
  ];

  for (const filePath of candidates) {
    try {
      const mod = await importTsModule(filePath);
      if (isValidGeneratedModule(mod)) {
        moduleCache.set(familyId, mod);
        return mod;
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

async function importTsModule(filePath: string): Promise<unknown> {
  const { existsSync } = await import("node:fs");
  if (!existsSync(filePath)) return null;

  // Use tsx to import the module in a subprocess and return the exports
  const script = `
    const mod = await import(${JSON.stringify("file://" + filePath)});
    const result = {
      hasCreateStrategy: typeof mod.createStrategy === "function",
      hasMetadata: mod.metadata != null,
      metadata: mod.metadata,
    };
    process.stdout.write(JSON.stringify(result));
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: path.dirname(filePath),
      timeout: 10_000
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("exit", async (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to import ${filePath}: ${stderr.slice(0, 200)}`));
        return;
      }
      try {
        const info = JSON.parse(stdout);
        if (!info.hasCreateStrategy || !info.hasMetadata) {
          reject(new Error(`Module ${filePath} missing createStrategy or metadata export`));
          return;
        }
        // For actual usage, we need the real module. Use dynamic import directly.
        // The subprocess was just validation. Now import for real:
        const realMod = await import("file://" + filePath);
        resolve(realMod);
      } catch (e) {
        reject(e);
      }
    });

    child.on("error", reject);
  });
}

export function clearDynamicCache(): void {
  moduleCache.clear();
}
