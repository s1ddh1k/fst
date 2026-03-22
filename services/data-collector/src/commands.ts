import {
  DEFAULT_MARKETS,
  DEFAULT_TIMEFRAMES,
  DEFAULT_UNIVERSE_LIMIT,
  DEFAULT_UNIVERSE_NAME
} from "./config.js";
import {
  closeDb,
  getEarliestCandleTime,
  getSelectedUniverseMarkets,
  insertSystemLog,
  replaceMarketUniverse,
  upsertCandles,
  upsertMarkets
} from "./db.js";
import {
  backfillCandles,
  getCollectorStatus,
  scanDataGaps,
  syncLatestCandles
} from "./collector-service.js";
import { UpbitClient } from "./upbit-client.js";
import type { Timeframe } from "./types.js";

function getOption(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);

  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function isTimeframe(value: string): value is Timeframe {
  return value === "1m" || value === "5m" || value === "15m" || value === "1h" || value === "1d";
}

function parseMarkets(value: string | undefined): string[] {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function parseTimeframes(value: string | undefined): Timeframe[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(isTimeframe);
}

async function resolveDefaultMarkets(): Promise<string[]> {
  const selectedUniverseMarkets = await getSelectedUniverseMarkets(DEFAULT_UNIVERSE_NAME);
  return selectedUniverseMarkets.length > 0 ? selectedUniverseMarkets : DEFAULT_MARKETS;
}

async function resolveMarketsForBatch(args: string[]): Promise<string[]> {
  const directMarkets = parseMarkets(getOption(args, "--markets"));
  if (directMarkets.length > 0) {
    return directMarkets;
  }

  const universeName = getOption(args, "--universe") ?? DEFAULT_UNIVERSE_NAME;
  const universeMarkets = await getSelectedUniverseMarkets(universeName);
  return universeMarkets.length > 0 ? universeMarkets : DEFAULT_MARKETS;
}

export async function syncMarkets(): Promise<void> {
  try {
    const client = new UpbitClient();
    const markets = await client.getMarkets();
    const saved = await upsertMarkets(markets);
    await insertSystemLog("data-collector", "info", "sync_markets", "Market sync completed", {
      received: markets.length,
      saved
    });

    console.log(`synced markets: ${saved}`);
  } finally {
    await closeDb();
  }
}

export async function fetchCandles(args: string[]): Promise<void> {
  const market = getOption(args, "--market");
  const timeframeValue = getOption(args, "--timeframe");
  const countValue = getOption(args, "--count");
  const to = getOption(args, "--to");

  if (!market) {
    throw new Error("Missing required option: --market");
  }

  if (!timeframeValue || !isTimeframe(timeframeValue)) {
    throw new Error("Missing or invalid option: --timeframe (allowed: 1m, 5m, 15m, 1h, 1d)");
  }

  const count = countValue ? Number.parseInt(countValue, 10) : 200;

  if (Number.isNaN(count) || count < 1 || count > 200) {
    throw new Error("Invalid option: --count must be between 1 and 200");
  }

  try {
    const client = new UpbitClient();
    const candles = await client.getCandles({
      market,
      timeframe: timeframeValue,
      count,
      to
    });
    const saved = await upsertCandles(market, timeframeValue, candles);

    console.log(
      JSON.stringify(
        {
          market,
          timeframe: timeframeValue,
          requested: count,
          received: candles.length,
          saved
        },
        null,
        2
      )
    );
    await insertSystemLog("data-collector", "info", "fetch_candles", "Fetch candles completed", {
      market,
      timeframe: timeframeValue,
      requested: count,
      received: candles.length,
      saved
    });
  } finally {
    await closeDb();
  }
}

export async function syncLatest(args: string[]): Promise<void> {
  const market = getOption(args, "--market");
  const timeframeValue = getOption(args, "--timeframe");

  if (!market) {
    throw new Error("Missing required option: --market");
  }

  if (!timeframeValue || !isTimeframe(timeframeValue)) {
    throw new Error("Missing or invalid option: --timeframe (allowed: 1m, 5m, 15m, 1h, 1d)");
  }

  try {
    const result = await syncLatestCandles(market, timeframeValue);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeDb();
  }
}

export async function backfill(args: string[]): Promise<void> {
  const market = getOption(args, "--market");
  const timeframeValue = getOption(args, "--timeframe");
  const pagesValue = getOption(args, "--pages");

  if (!market) {
    throw new Error("Missing required option: --market");
  }

  if (!timeframeValue || !isTimeframe(timeframeValue)) {
    throw new Error("Missing or invalid option: --timeframe (allowed: 1m, 5m, 15m, 1h, 1d)");
  }

  const pages = pagesValue ? Number.parseInt(pagesValue, 10) : 1;

  if (Number.isNaN(pages) || pages < 1) {
    throw new Error("Invalid option: --pages must be a positive integer");
  }

  try {
    const result = await backfillCandles(market, timeframeValue, pages);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeDb();
  }
}

export async function backfillBatch(args: string[]): Promise<void> {
  const timeframesValue = getOption(args, "--timeframes");
  const pagesValue = getOption(args, "--pages");

  const markets = await resolveMarketsForBatch(args);
  const timeframes = parseTimeframes(timeframesValue);
  const pages = pagesValue ? Number.parseInt(pagesValue, 10) : 1;

  if (markets.length === 0) {
    throw new Error("No markets available for backfill batch");
  }

  if (timeframes.length === 0 || !timeframes.every(isTimeframe)) {
    throw new Error("Missing or invalid option: --timeframes (allowed: 1m, 5m, 15m, 1h, 1d)");
  }

  try {
    const results = [];

    for (const market of markets) {
      for (const timeframe of timeframes) {
        const result = await backfillCandles(market, timeframe, pages);
        results.push(result);
      }
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await closeDb();
  }
}

export async function backfillUntil(args: string[]): Promise<void> {
  const targetValue = getOption(args, "--target");
  const timeframesValue = getOption(args, "--timeframes");
  const batchPagesValue = getOption(args, "--batch-pages");
  const maxBatchesValue = getOption(args, "--max-batches-per-market");
  const batchPages = batchPagesValue ? Number.parseInt(batchPagesValue, 10) : 25;
  const maxBatchesPerMarket = maxBatchesValue ? Number.parseInt(maxBatchesValue, 10) : null;
  const markets = await resolveMarketsForBatch(args);
  const timeframes = parseTimeframes(timeframesValue);

  if (!targetValue) {
    throw new Error("Missing required option: --target (example: 2021-01-01T00:00:00Z)");
  }

  const target = new Date(targetValue);
  if (Number.isNaN(target.getTime())) {
    throw new Error("Invalid option: --target must be an ISO datetime");
  }

  if (Number.isNaN(batchPages) || batchPages < 1) {
    throw new Error("Invalid option: --batch-pages must be a positive integer");
  }

  if (
    maxBatchesPerMarket !== null &&
    (Number.isNaN(maxBatchesPerMarket) || maxBatchesPerMarket < 1)
  ) {
    throw new Error("Invalid option: --max-batches-per-market must be a positive integer");
  }

  if (markets.length === 0) {
    throw new Error("No markets available for backfill until");
  }

  if (timeframes.length === 0 || !timeframes.every(isTimeframe)) {
    throw new Error("Missing or invalid option: --timeframes (allowed: 1m, 5m, 15m, 1h, 1d)");
  }

  try {
    const summary: Array<Record<string, unknown>> = [];

    for (const market of markets) {
      for (const timeframe of timeframes) {
        let batches = 0;
        let pages = 0;
        let fetched = 0;
        let saved = 0;
        let completed = false;
        let stoppedReason: string | null = null;
        let earliest = await getEarliestCandleTime(market, timeframe);

        while (true) {
          if (earliest && earliest <= target) {
            completed = true;
            stoppedReason = "target_reached";
            break;
          }

          if (maxBatchesPerMarket !== null && batches >= maxBatchesPerMarket) {
            stoppedReason = "max_batches_reached";
            break;
          }

          const beforeIso = earliest?.toISOString() ?? null;
          const result = await backfillCandles(market, timeframe, batchPages);
          const nextEarliest = await getEarliestCandleTime(market, timeframe);

          batches += 1;
          pages += batchPages;
          fetched += result.fetched;
          saved += result.saved;

          console.log(
            JSON.stringify({
              market,
              timeframe,
              target: target.toISOString(),
              batches,
              pages,
              fetched,
              saved,
              earliestBefore: beforeIso,
              earliestAfter: nextEarliest?.toISOString() ?? null
            })
          );

          if (result.fetched === 0) {
            stoppedReason = "no_more_remote_candles";
            earliest = nextEarliest;
            break;
          }

          if (
            earliest &&
            nextEarliest &&
            nextEarliest.getTime() >= earliest.getTime()
          ) {
            stoppedReason = "no_progress";
            earliest = nextEarliest;
            break;
          }

          earliest = nextEarliest;
        }

        summary.push({
          market,
          timeframe,
          target: target.toISOString(),
          completed,
          stoppedReason,
          batches,
          pages,
          fetched,
          saved,
          earliestCandleTimeUtc: earliest?.toISOString() ?? null
        });
      }
    }

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await closeDb();
  }
}

export async function syncLatestBatch(args: string[]): Promise<void> {
  const marketsValue = getOption(args, "--markets");
  const timeframesValue = getOption(args, "--timeframes");

  const markets = parseMarkets(marketsValue);
  const timeframes = parseTimeframes(timeframesValue);

  if (markets.length === 0) {
    throw new Error("Missing required option: --markets");
  }

  if (timeframes.length === 0) {
    throw new Error("Missing or invalid option: --timeframes (allowed: 1m, 5m, 15m, 1h, 1d)");
  }

  try {
    const results = [];

    for (const market of markets) {
      for (const timeframe of timeframes) {
        results.push(await syncLatestCandles(market, timeframe));
      }
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await closeDb();
  }
}

export async function backfillDefault(): Promise<void> {
  try {
    const results = [];
    const markets = await resolveDefaultMarkets();

    for (const market of markets) {
      for (const timeframe of DEFAULT_TIMEFRAMES) {
        results.push(await backfillCandles(market, timeframe, 1));
      }
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await closeDb();
  }
}

export async function syncLatestDefault(): Promise<void> {
  try {
    const results = [];
    const markets = await resolveDefaultMarkets();

    for (const market of markets) {
      for (const timeframe of DEFAULT_TIMEFRAMES) {
        results.push(await syncLatestCandles(market, timeframe));
      }
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await closeDb();
  }
}

export async function runOvernight(args: string[]): Promise<void> {
  const pagesValue = getOption(args, "--pages");
  const pages = pagesValue ? Number.parseInt(pagesValue, 10) : 10;

  if (Number.isNaN(pages) || pages < 1) {
    throw new Error("Invalid option: --pages must be a positive integer");
  }

  const results: Array<Record<string, unknown>> = [];

  try {
    const markets = await resolveDefaultMarkets();

    for (const market of markets) {
      for (const timeframe of DEFAULT_TIMEFRAMES) {
        try {
          const result = await backfillCandles(market, timeframe, pages);
          results.push({
            ok: true,
            ...result
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          await insertSystemLog(
            "data-collector",
            "error",
            "overnight_backfill_item_failed",
            message,
            {
              market,
              timeframe,
              pages
            }
          );

          results.push({
            market,
            timeframe,
            ok: false,
            error: message
          });
        }
      }
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await closeDb();
  }
}

export async function refreshUniverse(args: string[]): Promise<void> {
  const quoteValue = getOption(args, "--quote") ?? "KRW";
  const limitValue = getOption(args, "--limit");
  const limit = limitValue ? Number.parseInt(limitValue, 10) : DEFAULT_UNIVERSE_LIMIT;
  const universeName = getOption(args, "--name") ?? DEFAULT_UNIVERSE_NAME;

  if (Number.isNaN(limit) || limit < 1) {
    throw new Error("Invalid option: --limit must be a positive integer");
  }

  try {
    const client = new UpbitClient();
    const [markets, tickers] = await Promise.all([
      client.getMarkets(),
      client.getTickersByQuote([quoteValue])
    ]);

    const warningByMarket = new Map(
      markets.map((market) => [market.market, market.market_event?.warning ?? false])
    );

    const selectedTickers = tickers
      .filter((ticker) => ticker.market.startsWith(`${quoteValue}-`))
      .filter((ticker) => !warningByMarket.get(ticker.market))
      .sort((left, right) => right.acc_trade_price_24h - left.acc_trade_price_24h)
      .slice(0, limit);

    const saved = await replaceMarketUniverse({
      universeName,
      quoteCurrency: quoteValue,
      selectionReason: `top_${limit}_by_acc_trade_price_24h_without_warning`,
      selectedMarkets: selectedTickers,
      warningByMarket
    });

    await insertSystemLog("data-collector", "info", "refresh_universe", "Universe refresh completed", {
      universeName,
      quoteCurrency: quoteValue,
      requestedLimit: limit,
      saved
    });

    console.log(
      JSON.stringify(
        {
          universeName,
          quoteCurrency: quoteValue,
          requestedLimit: limit,
          saved,
          markets: selectedTickers.map((ticker, index) => ({
            rank: index + 1,
            market: ticker.market,
            acc_trade_price_24h: ticker.acc_trade_price_24h
          }))
        },
        null,
        2
      )
    );
  } finally {
    await closeDb();
  }
}

export async function status(): Promise<void> {
  try {
    const result = await getCollectorStatus();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeDb();
  }
}

export async function scanGaps(args: string[]): Promise<void> {
  const market = getOption(args, "--market");
  const timeframeValue = getOption(args, "--timeframe");

  if (!market) {
    throw new Error("Missing required option: --market");
  }

  if (!timeframeValue || !isTimeframe(timeframeValue)) {
    throw new Error("Missing or invalid option: --timeframe (allowed: 1m, 5m, 15m, 1h, 1d)");
  }

  try {
    const result = await scanDataGaps(market, timeframeValue);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeDb();
  }
}

export async function scanGapsDefault(): Promise<void> {
  try {
    const results = [];

    for (const market of DEFAULT_MARKETS) {
      for (const timeframe of DEFAULT_TIMEFRAMES) {
        results.push(await scanDataGaps(market, timeframe));
      }
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await closeDb();
  }
}

export function printHelp(): void {
  console.log(`Usage:
  pnpm --filter @fst/data-collector dev sync-markets
  pnpm --filter @fst/data-collector dev fetch-candles --market KRW-BTC --timeframe 1d [--count 30] [--to 2025-12-31T00:00:00]
  pnpm --filter @fst/data-collector dev sync-latest --market KRW-BTC --timeframe 1d
  pnpm --filter @fst/data-collector dev backfill --market KRW-BTC --timeframe 1d [--pages 10]
  pnpm --filter @fst/data-collector dev backfill-batch --markets KRW-BTC,KRW-ETH --timeframes 15m,1h,1d [--pages 10]
  pnpm --filter @fst/data-collector dev backfill-until [--markets KRW-BTC,KRW-ETH | --universe krw-top] --timeframes 15m,1h,1d --target 2021-01-01T00:00:00Z [--batch-pages 25] [--max-batches-per-market 20]
  pnpm --filter @fst/data-collector dev sync-latest-batch --markets KRW-BTC,KRW-ETH --timeframes 15m,1h,1d
  pnpm --filter @fst/data-collector dev backfill-default
  pnpm --filter @fst/data-collector dev sync-latest-default
  pnpm --filter @fst/data-collector dev run-overnight [--pages 10]
  pnpm --filter @fst/data-collector dev status
  pnpm --filter @fst/data-collector dev scan-gaps --market KRW-BTC --timeframe 1d
  pnpm --filter @fst/data-collector dev scan-gaps-default
  pnpm --filter @fst/data-collector dev refresh-universe [--quote KRW] [--limit 30] [--name krw-top]
`);
}
