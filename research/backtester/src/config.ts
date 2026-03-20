import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env" });

/** @deprecated Use getDb() from @fst/shared instead. Kept for backward compat. */
export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/fst";

export const DEFAULT_INITIAL_CAPITAL = Number.parseInt(
  process.env.BACKTEST_INITIAL_CAPITAL ?? "1000000",
  10
);

// Upbit KRW spot: 0.05% standard, 0.025% with fee coupon (common).
// Use coupon rate as default — matches real trading conditions.
export const DEFAULT_FEE_RATE = Number.parseFloat(process.env.BACKTEST_FEE_RATE ?? "0.00025");

export const DEFAULT_SLIPPAGE_RATE = Number.parseFloat(
  process.env.BACKTEST_SLIPPAGE_RATE ?? "0.0005"
);
