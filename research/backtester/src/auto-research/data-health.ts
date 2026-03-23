import { getDb } from "../sqlite.js";

export type DataFreshnessResult = {
  ok: boolean;
  newestCandleTime: Date | null;
  ageHours: number;
  warning?: string;
  refusal?: string;
};

export function checkDataFreshness(params: {
  timeframe?: string;
  allowStaleData?: boolean;
  warnThresholdHours?: number;
  refuseThresholdHours?: number;
}): DataFreshnessResult {
  const tf = params.timeframe ?? "1h";
  const warnH = params.warnThresholdHours ?? 48;
  const refuseH = params.refuseThresholdHours ?? 168;

  try {
    const db = getDb();
    const row = db.prepare(
      "SELECT MAX(candle_time_utc) as newest FROM candles WHERE timeframe = ?"
    ).get(tf) as { newest: string | null } | undefined;

    if (!row?.newest) {
      return {
        ok: false,
        newestCandleTime: null,
        ageHours: Infinity,
        refusal: `No candles found for timeframe ${tf}`
      };
    }

    const newest = new Date(row.newest);
    const ageHours = (Date.now() - newest.getTime()) / (3600 * 1000);

    if (ageHours > refuseH && !params.allowStaleData) {
      return {
        ok: false,
        newestCandleTime: newest,
        ageHours: Math.round(ageHours),
        refusal: `Data is ${Math.round(ageHours)}h old (threshold: ${refuseH}h). Use --allow-stale-data to override.`
      };
    }

    const warning = ageHours > warnH
      ? `Data is ${Math.round(ageHours)}h old (warning threshold: ${warnH}h). Consider running data collection.`
      : undefined;

    return {
      ok: true,
      newestCandleTime: newest,
      ageHours: Math.round(ageHours),
      warning
    };
  } catch (error) {
    // DB not available (e.g. test environment) — allow anyway
    return {
      ok: true,
      newestCandleTime: null,
      ageHours: 0,
      warning: `Could not check data freshness: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
