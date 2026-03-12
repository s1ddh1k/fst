import "dotenv/config";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/fst";

export const PAPER_STARTING_BALANCE = Number.parseFloat(
  process.env.PAPER_STARTING_BALANCE ?? "1000000"
);
export const PAPER_FEE_RATE = Number.parseFloat(process.env.PAPER_FEE_RATE ?? "0.0005");
export const PAPER_SLIPPAGE_RATE = Number.parseFloat(process.env.PAPER_SLIPPAGE_RATE ?? "0.0003");
export const PAPER_TRADER_HOST = process.env.PAPER_TRADER_HOST ?? "127.0.0.1";
export const PAPER_TRADER_PORT = Number.parseInt(process.env.PAPER_TRADER_PORT ?? "8787", 10);

export const DEFAULT_UNIVERSE_NAME = process.env.COLLECTOR_UNIVERSE_NAME ?? "krw-top";
export const DEFAULT_REGIME_NAME = "walk-forward-recommendation";
export const DEFAULT_TIMEFRAME = "1d";
