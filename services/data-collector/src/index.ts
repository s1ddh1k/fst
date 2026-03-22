import { DEFAULT_MARKETS, DEFAULT_TIMEFRAMES } from "./config.js";
import {
  backfill,
  backfillBatch,
  backfillUntil,
  backfillDefault,
  fetchCandles,
  printHelp,
  refreshUniverse,
  runOvernight,
  scanGaps,
  scanGapsDefault,
  status,
  syncLatest,
  syncLatestBatch,
  syncLatestDefault,
  syncMarkets
} from "./commands.js";

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (!command) {
    console.log("data-collector ready");
    console.log(
      JSON.stringify(
        {
          service: "data-collector",
          markets: DEFAULT_MARKETS,
          timeframes: DEFAULT_TIMEFRAMES
        },
        null,
        2
      )
    );
    printHelp();
    return;
  }

  if (command === "sync-markets") {
    await syncMarkets();
    return;
  }

  if (command === "fetch-candles") {
    await fetchCandles(args);
    return;
  }

  if (command === "sync-latest") {
    await syncLatest(args);
    return;
  }

  if (command === "backfill") {
    await backfill(args);
    return;
  }

  if (command === "backfill-batch") {
    await backfillBatch(args);
    return;
  }

  if (command === "backfill-until") {
    await backfillUntil(args);
    return;
  }

  if (command === "sync-latest-batch") {
    await syncLatestBatch(args);
    return;
  }

  if (command === "backfill-default") {
    await backfillDefault();
    return;
  }

  if (command === "sync-latest-default") {
    await syncLatestDefault();
    return;
  }

  if (command === "run-overnight") {
    await runOvernight(args);
    return;
  }

  if (command === "refresh-universe") {
    await refreshUniverse(args);
    return;
  }

  if (command === "status") {
    await status();
    return;
  }

  if (command === "scan-gaps") {
    await scanGaps(args);
    return;
  }

  if (command === "scan-gaps-default") {
    await scanGapsDefault();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
