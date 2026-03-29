/**
 * Diagnostic script to check adaptive regime classification on real candle data.
 * Loads BTC candles from the database and compares default vs adaptive regime.
 */
import { loadCandlesForMarkets } from "../src/db.js";
import { buildMarketStateContexts } from "../../strategies/src/market-state.js";

async function main() {
  // Load 15m candles for a few markets
  const markets = ["KRW-BTC", "KRW-ETH", "KRW-XRP"];
  const candles15m: Record<string, any[]> = {};

  for (const market of markets) {
    const rows = await loadCandlesForMarkets({ marketCodes: [market], timeframe: "15m" });
    candles15m[market] = rows[market] ?? [];
  }

  const btcCandles = candles15m["KRW-BTC"];
  if (btcCandles.length === 0) {
    console.log("No BTC candles found");
    return;
  }

  console.log(`Loaded ${btcCandles.length} BTC 15m candles`);
  console.log(`Date range: ${btcCandles[0].candleTimeUtc.toISOString()} to ${btcCandles[btcCandles.length - 1].candleTimeUtc.toISOString()}`);

  // Check regime at multiple points
  const checkPoints = [
    Math.floor(btcCandles.length * 0.25),
    Math.floor(btcCandles.length * 0.5),
    Math.floor(btcCandles.length * 0.75),
    btcCandles.length - 1
  ];

  for (const idx of checkPoints) {
    const refTime = btcCandles[idx].candleTimeUtc;
    console.log(`\n=== ${refTime.toISOString()} (index ${idx}) ===`);

    // Default regime
    const defaultCtx = buildMarketStateContexts({
      referenceTime: refTime,
      alignedIndex: idx,
      universeCandlesByMarket: candles15m,
      config: undefined // default
    });
    const defaultRegime = Object.values(defaultCtx)[0]?.composite?.regime ?? "no_data";
    const defaultBreadth = Object.values(defaultCtx)[0]?.breadth;

    // Adaptive regime
    const adaptiveCtx = buildMarketStateContexts({
      referenceTime: refTime,
      alignedIndex: idx,
      universeCandlesByMarket: candles15m,
      config: { useAdaptiveRegime: true }
    });
    const adaptiveRegime = Object.values(adaptiveCtx)[0]?.composite?.regime ?? "no_data";
    const adaptiveBreadth = Object.values(adaptiveCtx)[0]?.breadth;

    console.log(`Default regime:  ${defaultRegime}`);
    console.log(`Adaptive regime: ${adaptiveRegime}`);
    if (defaultBreadth) {
      console.log(`Breadth - riskOn: ${defaultBreadth.riskOnScore?.toFixed(3)}, aboveTrend: ${defaultBreadth.aboveTrendRatio?.toFixed(3)}, compositeTrend: ${defaultBreadth.compositeTrendScore?.toFixed(3)}`);
    }
  }

  // Count regime distribution over last 5000 bars
  const sampleStart = Math.max(0, btcCandles.length - 5000);
  const sampleEnd = btcCandles.length;
  const step = 20; // check every 20 bars (5h intervals)
  const defaultCounts: Record<string, number> = {};
  const adaptiveCounts: Record<string, number> = {};

  for (let i = sampleStart; i < sampleEnd; i += step) {
    const refTime = btcCandles[i].candleTimeUtc;

    const defaultCtx = buildMarketStateContexts({
      referenceTime: refTime,
      alignedIndex: i,
      universeCandlesByMarket: candles15m,
      config: undefined
    });
    const defaultRegime = Object.values(defaultCtx)[0]?.composite?.regime ?? "no_data";
    defaultCounts[defaultRegime] = (defaultCounts[defaultRegime] ?? 0) + 1;

    const adaptiveCtx = buildMarketStateContexts({
      referenceTime: refTime,
      alignedIndex: i,
      universeCandlesByMarket: candles15m,
      config: { useAdaptiveRegime: true }
    });
    const adaptiveRegime = Object.values(adaptiveCtx)[0]?.composite?.regime ?? "no_data";
    adaptiveCounts[adaptiveRegime] = (adaptiveCounts[adaptiveRegime] ?? 0) + 1;
  }

  const total = Object.values(defaultCounts).reduce((s, v) => s + v, 0);
  console.log(`\n=== Regime Distribution (last 5000 bars, sampled every ${step}) ===`);
  console.log(`Total samples: ${total}`);
  console.log("\nDefault regime:");
  for (const [regime, count] of Object.entries(defaultCounts).sort(([, a], [, b]) => b - a)) {
    console.log(`  ${regime}: ${count} (${((count / total) * 100).toFixed(1)}%)`);
  }
  console.log("\nAdaptive regime:");
  for (const [regime, count] of Object.entries(adaptiveCounts).sort(([, a], [, b]) => b - a)) {
    console.log(`  ${regime}: ${count} (${((count / total) * 100).toFixed(1)}%)`);
  }
}

main().catch(console.error);
