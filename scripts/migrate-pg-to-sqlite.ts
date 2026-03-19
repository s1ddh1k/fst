/**
 * One-time migration script: PostgreSQL → SQLite
 *
 * Usage:
 *   docker compose up -d   # PG must be running
 *   pnpm exec tsx scripts/migrate-pg-to-sqlite.ts
 *
 * This reads all data from PG and writes it to data/fst.db (SQLite).
 * Existing SQLite file will be overwritten.
 */

import pg from "pg";
import Database from "better-sqlite3";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";

const PG_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/fst";
const SQLITE_PATH = process.env.SQLITE_PATH ?? path.join(process.cwd(), "data", "fst.db");
const SCHEMA_PATH = path.join(process.cwd(), "infra", "db", "init-sqlite.sql");

async function main() {
  console.log(`[migrate] PG: ${PG_URL}`);
  console.log(`[migrate] SQLite: ${SQLITE_PATH}`);

  // Prepare SQLite
  const dir = path.dirname(SQLITE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (existsSync(SQLITE_PATH)) {
    console.log("[migrate] Removing existing SQLite file");
    unlinkSync(SQLITE_PATH);
  }

  const sqlite = new Database(SQLITE_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = OFF"); // disable during migration
  sqlite.pragma("synchronous = OFF");  // speed up bulk inserts

  const schema = readFileSync(SCHEMA_PATH, "utf8");
  sqlite.exec(schema);

  // Connect to PG
  const pgPool = new pg.Pool({ connectionString: PG_URL });

  const tables = [
    "markets",
    "market_universe",
    "candles",
    "market_breadth_features",
    "market_relative_strength_features",
    "collector_runs",
    "collector_run_items",
    "collector_state",
    "data_gaps",
    "backtest_runs",
    "backtest_metrics",
    "strategy_regimes",
    "paper_sessions",
    "paper_orders",
    "paper_positions",
    "system_logs"
  ];

  for (const table of tables) {
    await migrateTable(pgPool, sqlite, table);
  }

  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.close();
  await pgPool.end();
  console.log("[migrate] Done!");
}

async function migrateTable(pgPool: pg.Pool, sqlite: Database.Database, table: string) {
  const countResult = await pgPool.query(`SELECT COUNT(*) as count FROM ${table}`);
  const totalRows = parseInt(countResult.rows[0].count, 10);
  console.log(`[migrate] ${table}: ${totalRows} rows`);

  if (totalRows === 0) return;

  // Get column info from PG
  const colResult = await pgPool.query(`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = $1
    ORDER BY ordinal_position
  `, [table]);

  const pgColumns = colResult.rows as Array<{
    column_name: string;
    data_type: string;
    udt_name: string;
  }>;

  // Check which columns exist in SQLite
  const sqliteColumns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const sqliteColumnNames = new Set(sqliteColumns.map((c) => c.name));

  // Only migrate columns that exist in both
  const columns = pgColumns.filter((c) => sqliteColumnNames.has(c.column_name));
  const columnNames = columns.map((c) => c.column_name);

  // Boolean and array columns need conversion
  const booleanColumns = new Set(columns.filter((c) => c.udt_name === "bool").map((c) => c.column_name));
  const arrayColumns = new Set(columns.filter((c) => c.data_type === "ARRAY").map((c) => c.column_name));
  const jsonColumns = new Set(columns.filter((c) => c.udt_name === "jsonb" || c.udt_name === "json").map((c) => c.column_name));
  const timestampColumns = new Set(columns.filter((c) => c.udt_name === "timestamptz" || c.udt_name === "timestamp").map((c) => c.column_name));

  const selectSql = `SELECT ${columnNames.map((c) => `"${c}"`).join(", ")} FROM ${table} ORDER BY id`;
  const insertSql = `INSERT OR IGNORE INTO ${table} (${columnNames.join(", ")}) VALUES (${columnNames.map(() => "?").join(", ")})`;

  const insertStmt = sqlite.prepare(insertSql);
  const batchSize = 1000;
  let offset = 0;
  let migrated = 0;

  const insertMany = sqlite.transaction((rows: unknown[][]) => {
    for (const row of rows) {
      insertStmt.run(...row);
    }
  });

  while (offset < totalRows) {
    const { rows } = await pgPool.query(`${selectSql} LIMIT ${batchSize} OFFSET ${offset}`);

    const converted = rows.map((row) => {
      return columnNames.map((col) => {
        let value = row[col];
        if (value === null || value === undefined) return null;

        if (booleanColumns.has(col)) {
          return value ? 1 : 0;
        }
        if (arrayColumns.has(col)) {
          return JSON.stringify(value);
        }
        if (jsonColumns.has(col)) {
          return typeof value === "string" ? value : JSON.stringify(value);
        }
        if (timestampColumns.has(col) && value instanceof Date) {
          return value.toISOString();
        }

        return value;
      });
    });

    insertMany(converted);
    migrated += rows.length;
    offset += batchSize;

    if (migrated % 10000 === 0 || migrated === totalRows) {
      console.log(`[migrate] ${table}: ${migrated}/${totalRows}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
