import Database from "better-sqlite3";
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

let db: Database.Database | undefined;

function findSchemaPath(): string {
  // Walk up from cwd to find infra/db/init-sqlite.sql
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "infra", "db", "init-sqlite.sql");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Cannot find infra/db/init-sqlite.sql");
}

function findWorkspaceRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function isWritableDirectory(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDbPath(): string {
  if (process.env.SQLITE_PATH) return process.env.SQLITE_PATH;
  const workspaceRoot = findWorkspaceRoot();
  const preferredDir = path.join(workspaceRoot, "data");

  if (!existsSync(preferredDir) || isWritableDirectory(preferredDir)) {
    return path.join(preferredDir, "fst.db");
  }

  return path.join(workspaceRoot, ".sqlite", "fst.db");
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = resolveDbPath();
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  // Initialize schema if needed
  try {
    const schemaPath = findSchemaPath();
    const schema = readFileSync(schemaPath, "utf8");
    db.exec(schema);
  } catch {
    // Schema already applied or file not found in test environments
  }

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}

export function getDbPath(): string {
  return resolveDbPath();
}
