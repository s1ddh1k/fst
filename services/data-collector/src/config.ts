import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env" });

function parseCsvEnv(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const DEFAULT_MARKETS = parseCsvEnv(process.env.COLLECTOR_MARKETS, [
  "KRW-BTC",
  "KRW-ETH",
  "KRW-XRP",
  "KRW-SOL",
  "KRW-DOGE"
]);

export const DEFAULT_TIMEFRAMES = parseCsvEnv(process.env.COLLECTOR_TIMEFRAMES, [
  "1m",
  "5m",
  "15m",
  "1h",
  "1d"
]) as ("1m" | "5m" | "15m" | "1h" | "1d")[];

export const UPBIT_REST_BASE_URL = "https://api.upbit.com/v1";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/fst";

export const REQUEST_RETRY_COUNT = Number.parseInt(process.env.COLLECTOR_REQUEST_RETRY_COUNT ?? "3", 10);

export const REQUEST_RETRY_DELAY_MS = Number.parseInt(
  process.env.COLLECTOR_REQUEST_RETRY_DELAY_MS ?? "500",
  10
);

export const DEFAULT_UNIVERSE_NAME = process.env.COLLECTOR_UNIVERSE_NAME ?? "krw-top";

export const DEFAULT_UNIVERSE_LIMIT = Number.parseInt(
  process.env.COLLECTOR_UNIVERSE_LIMIT ?? "30",
  10
);
