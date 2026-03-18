import { existsSync } from "node:fs";
import path from "node:path";

const ROOT_RELATIVE_PREFIXES = ["research", "services", "apps", "infra", "packages", "docs", "scripts"];

export function findWorkspaceRoot(startDir: string): string {
  let current = path.resolve(startDir);

  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml")) || existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

export function resolveWorkspaceRelativePath(inputPath: string, cwd = process.cwd()): string {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  const normalized = inputPath.replace(/\\/g, "/");
  const firstSegment = normalized.split("/")[0] ?? "";
  if (ROOT_RELATIVE_PREFIXES.includes(firstSegment)) {
    return path.resolve(findWorkspaceRoot(cwd), inputPath);
  }

  return path.resolve(cwd, inputPath);
}
