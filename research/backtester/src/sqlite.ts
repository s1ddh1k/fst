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
  const busyTimeout = parseInt(process.env.FST_SQLITE_BUSY_TIMEOUT ?? "30000", 10);
  db.pragma(`busy_timeout = ${busyTimeout}`);

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

export function withDbRetry<T>(fn: () => T, maxRetries = 3): T {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/SQLITE_BUSY|database is locked/i.test(msg) && attempt < maxRetries) {
        const delayMs = 1000 * 2 ** attempt + Math.floor(Math.random() * 500);
        console.warn(`[sqlite] BUSY retry attempt=${attempt + 1}/${maxRetries} delay=${delayMs}ms`);
        const start = Date.now();
        while (Date.now() - start < delayMs) { /* spin-wait for sync better-sqlite3 */ }
        continue;
      }
      throw error;
    }
  }
  throw new Error("withDbRetry: unreachable");
}

export function walCheckpoint(): void {
  try {
    const database = getDb();
    database.pragma("wal_checkpoint(PASSIVE)");
  } catch (error) {
    console.warn(`[sqlite] WAL checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
