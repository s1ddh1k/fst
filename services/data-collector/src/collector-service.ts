import {
  clearOpenDataGaps,
  createCollectorRun,
  createCollectorRunItem,
  finishCollectorRun,
  finishCollectorRunItem,
  getCandleTimes,
  getCollectorStateRows,
  getEarliestCandleTime,
  getLatestCandleTime,
  getRecentCollectorRuns,
  insertSystemLog,
  updateCollectorState,
  upsertDataGap,
  upsertCandles
} from "./db.js";
import { getTimeframeMinutes, shiftBackward } from "./timeframe.js";
import type { Timeframe, UpbitCandle } from "./types.js";
import { UpbitClient } from "./upbit-client.js";
import { sleep } from "./utils.js";

type SyncLatestResult = {
  market: string;
  timeframe: Timeframe;
  received: number;
  saved: number;
  latestExisting: string | null;
};

type BackfillResult = {
  market: string;
  timeframe: Timeframe;
  pages: number;
  fetched: number;
  saved: number;
  oldestCursor: string | null;
};

type GapScanResult = {
  market: string;
  timeframe: Timeframe;
  candleCount: number;
  detectedGapCount: number;
};

function toIsoWithoutMilliseconds(date: Date): string {
  return date.toISOString().slice(0, 19);
}

function filterNewerCandles(candles: UpbitCandle[], latestExisting: Date | null): UpbitCandle[] {
  if (!latestExisting) {
    return candles;
  }

  return candles.filter((candle) => new Date(candle.candle_date_time_utc) > latestExisting);
}

export async function syncLatestCandles(
  market: string,
  timeframe: Timeframe
): Promise<SyncLatestResult> {
  const run = await createCollectorRun("sync_latest_candles", market, timeframe);
  const itemId = await createCollectorRunItem({
    collectorRunId: run.id,
    marketCode: market,
    timeframe,
    itemType: "sync_latest_candles",
    requestedCount: 200
  });

  try {
    const latestExisting = await getLatestCandleTime(market, timeframe);
    const client = new UpbitClient();
    const candles = await client.getCandles({
      market,
      timeframe,
      count: 200
    });
    const filtered = filterNewerCandles(candles, latestExisting);
    const saved = await upsertCandles(market, timeframe, filtered);

    const latestFetched = candles[0] ? new Date(candles[0].candle_date_time_utc) : latestExisting;

    await finishCollectorRun(run.id, "success", `received=${candles.length}, saved=${saved}`);
    await finishCollectorRunItem({
      itemId,
      status: "success",
      receivedCount: candles.length,
      savedCount: saved,
      message: `received=${candles.length}, saved=${saved}`
    });
    await updateCollectorState({
      marketCode: market,
      timeframe,
      latestCandleTimeUtc: latestFetched ?? null,
      runType: "sync_latest_candles",
      status: "success",
      message: `received=${candles.length}, saved=${saved}`
    });
    await insertSystemLog("data-collector", "info", "sync_latest_candles", "Sync latest completed", {
      market,
      timeframe,
      received: candles.length,
      saved
    });

    return {
      market,
      timeframe,
      received: candles.length,
      saved,
      latestExisting: latestExisting?.toISOString() ?? null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishCollectorRun(run.id, "failed", message);
    await finishCollectorRunItem({
      itemId,
      status: "failed",
      message
    });
    await updateCollectorState({
      marketCode: market,
      timeframe,
      runType: "sync_latest_candles",
      status: "failed",
      message
    });
    await insertSystemLog("data-collector", "error", "sync_latest_candles_failed", message, {
      market,
      timeframe
    });
    throw error;
  }
}

export async function backfillCandles(
  market: string,
  timeframe: Timeframe,
  pages: number
): Promise<BackfillResult> {
  const run = await createCollectorRun("backfill_candles", market, timeframe);

  try {
    const client = new UpbitClient();
    const earliestExisting = await getEarliestCandleTime(market, timeframe);

    let cursor = earliestExisting ? toIsoWithoutMilliseconds(earliestExisting) : undefined;
    let totalFetched = 0;
    let totalSaved = 0;

    for (let page = 0; page < pages; page += 1) {
      const itemId = await createCollectorRunItem({
        collectorRunId: run.id,
        marketCode: market,
        timeframe,
        itemType: "backfill_page",
        requestedCount: 200,
        cursorTimeUtc: cursor ? new Date(cursor) : null
      });

      const candles = await client.getCandles({
        market,
        timeframe,
        count: 200,
        to: cursor
      });

      if (candles.length === 0) {
        await finishCollectorRunItem({
          itemId,
          status: "success",
          receivedCount: 0,
          savedCount: 0,
          message: "no_more_candles"
        });
        break;
      }

      totalFetched += candles.length;
      const saved = await upsertCandles(market, timeframe, candles);
      totalSaved += saved;

      const oldest = candles[candles.length - 1];
      const newest = candles[0];

      if (candles.length < 200) {
        await upsertDataGap({
          marketCode: market,
          timeframe,
          gapStartUtc: new Date(oldest.candle_date_time_utc),
          gapEndUtc: new Date(newest.candle_date_time_utc),
          resolutionMessage: "short_page_detected"
        });
      }

      await finishCollectorRunItem({
        itemId,
        status: "success",
        receivedCount: candles.length,
        savedCount: saved,
        message: `received=${candles.length}, saved=${saved}`
      });

      cursor = toIsoWithoutMilliseconds(
        shiftBackward(new Date(oldest.candle_date_time_utc), timeframe, 1)
      );

      await sleep(120);
    }

    await finishCollectorRun(
      run.id,
      "success",
      `pages=${pages}, fetched=${totalFetched}, saved=${totalSaved}`
    );
    await updateCollectorState({
      marketCode: market,
      timeframe,
      earliestCandleTimeUtc: await getEarliestCandleTime(market, timeframe),
      latestCandleTimeUtc: await getLatestCandleTime(market, timeframe),
      runType: "backfill_candles",
      status: "success",
      message: `pages=${pages}, fetched=${totalFetched}, saved=${totalSaved}`
    });
    await insertSystemLog("data-collector", "info", "backfill_candles", "Backfill completed", {
      market,
      timeframe,
      pages,
      fetched: totalFetched,
      saved: totalSaved
    });

    return {
      market,
      timeframe,
      pages,
      fetched: totalFetched,
      saved: totalSaved,
      oldestCursor: cursor ?? null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishCollectorRun(run.id, "failed", message);
    await updateCollectorState({
      marketCode: market,
      timeframe,
      runType: "backfill_candles",
      status: "failed",
      message
    });
    await insertSystemLog("data-collector", "error", "backfill_candles_failed", message, {
      market,
      timeframe,
      pages
    });
    throw error;
  }
}

export async function scanDataGaps(
  market: string,
  timeframe: Timeframe
): Promise<GapScanResult> {
  const timestamps = await getCandleTimes(market, timeframe);
  const expectedMs = getTimeframeMinutes(timeframe) * 60_000;
  let detectedGapCount = 0;

  await clearOpenDataGaps(market, timeframe);

  for (let index = 1; index < timestamps.length; index += 1) {
    const previous = timestamps[index - 1];
    const current = timestamps[index];
    const diff = current.getTime() - previous.getTime();

    if (diff > expectedMs) {
      detectedGapCount += 1;

      await upsertDataGap({
        marketCode: market,
        timeframe,
        gapStartUtc: new Date(previous.getTime() + expectedMs),
        gapEndUtc: new Date(current.getTime() - expectedMs),
        resolutionMessage: `detected_gap_diff_ms=${diff}`
      });
    }
  }

  await insertSystemLog("data-collector", "info", "scan_data_gaps", "Gap scan completed", {
    market,
    timeframe,
    candleCount: timestamps.length,
    detectedGapCount
  });

  return {
    market,
    timeframe,
    candleCount: timestamps.length,
    detectedGapCount
  };
}

export async function getCollectorStatus(): Promise<{
  states: Awaited<ReturnType<typeof getCollectorStateRows>>;
  recentRuns: Awaited<ReturnType<typeof getRecentCollectorRuns>>;
}> {
  const [states, recentRuns] = await Promise.all([getCollectorStateRows(), getRecentCollectorRuns()]);

  return {
    states,
    recentRuns
  };
}
