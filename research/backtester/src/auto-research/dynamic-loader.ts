import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isValidGeneratedModule, type GeneratedStrategyModule } from "./strategy-template.js";

const moduleCache = new Map<string, GeneratedStrategyModule>();

function findGeneratedStrategiesDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "research", "backtester", "src", "generated-strategies");
    if (existsSync(candidate)) return candidate;
    const localCandidate = path.join(dir, "src", "generated-strategies");
    if (existsSync(localCandidate)) return localCandidate;
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
  if (moduleCache.has(familyId)) return moduleCache.get(familyId)!;

  const dir = findGeneratedStrategiesDir();
  const candidates = [
    path.join(dir, `${familyId}.ts`),
    path.join(dir, `${familyId.replace(/^(block:|generated:)/, "")}.ts`),
    path.join(dir, `${familyId.replace(/[^a-zA-Z0-9-]/g, "-")}.ts`)
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
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

function unwrapModule(mod: Record<string, unknown>): unknown {
  // tsx wraps named exports under mod.default in some cases
  if (mod.createStrategy) return mod;
  if (mod.default && typeof mod.default === "object") {
    const def = mod.default as Record<string, unknown>;
    if (def.createStrategy) return def;
  }
  // CommonJS-style wrapping
  if (mod["module.exports"] && typeof mod["module.exports"] === "object") {
    const cjs = mod["module.exports"] as Record<string, unknown>;
    if (cjs.createStrategy) return cjs;
  }
  return mod;
}

async function importTsModule(filePath: string): Promise<unknown> {
  // Cache-bust by appending timestamp query param
  const url = `file://${filePath}?t=${Date.now()}`;
  const rawMod = await import(url);
  return unwrapModule(rawMod as Record<string, unknown>);
}

export function clearDynamicCache(): void {
  moduleCache.clear();
}
