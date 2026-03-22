import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCandlesToFullGrid } from "../src/universe/candle-normalizer.js";
import { buildPointInTimeUniverse } from "../src/universe/universe-selector.js";
import { buildMarketStateContext } from "../../strategies/src/market-state.js";
import { createHourlyCandles } from "./test-helpers.js";

function buildMacroDowntrendWithLateBounce(params: {
  marketCode: string;
  startPrice: number;
  troughPrice: number;
  bouncePrice: number;
  totalBars?: number;
  bounceBars?: number;
}) {
  const totalBars = params.totalBars ?? 24 * 90;
  const bounceBars = params.bounceBars ?? 48;
  const downtrendBars = Math.max(2, totalBars - bounceBars);
  const closes = Array.from({ length: totalBars }, (_, index) => {
    if (index < downtrendBars) {
      const progress = index / Math.max(downtrendBars - 1, 1);
      return params.startPrice + (params.troughPrice - params.startPrice) * progress;
    }

    const progress = (index - downtrendBars) / Math.max(bounceBars - 1, 1);
    return params.troughPrice + (params.bouncePrice - params.troughPrice) * progress;
  });

  return createHourlyCandles({
    marketCode: params.marketCode,
    closes
  });
}

test("normalizeCandlesToFullGrid fills missing bars with synthetic candles", () => {
  const marketA = createHourlyCandles({
    marketCode: "KRW-A",
    closes: [100, 102]
  });
  const marketB = createHourlyCandles({
    marketCode: "KRW-B",
    closes: [200, 201, 202]
  });
  marketA[1] = {
    ...marketA[1],
    candleTimeUtc: new Date("2024-01-01T02:00:00.000Z")
  };

  const normalized = normalizeCandlesToFullGrid({
    candlesByMarket: {
      "KRW-A": marketA,
      "KRW-B": marketB
    },
    timeframe: "1h"
  });

  const candles = normalized.candlesByMarket["KRW-A"];
  assert.equal(normalized.timeline.length, 3);
  assert.equal(candles.length, 3);
  assert.equal(candles[1]?.isSynthetic, true);
  assert.equal(candles[1]?.openPrice, 100);
  assert.equal(candles[1]?.highPrice, 100);
  assert.equal(candles[1]?.lowPrice, 100);
  assert.equal(candles[1]?.closePrice, 100);
  assert.equal(candles[1]?.volume, 0);
  assert.equal(candles[1]?.quoteVolume, 0);
});

test("buildPointInTimeUniverse uses only prior rolling turnover", () => {
  const marketA = createHourlyCandles({
    marketCode: "KRW-A",
    closes: [100, 101, 102, 103, 104, 105],
    volumes: [100, 100, 100, 1, 1, 1]
  });
  const marketB = createHourlyCandles({
    marketCode: "KRW-B",
    closes: [100, 101, 102, 103, 104, 105],
    volumes: [1, 1, 1, 200, 200, 200]
  });

  const snapshots = buildPointInTimeUniverse({
    candlesByMarket: {
      "KRW-A": marketA,
      "KRW-B": marketB
    },
    timeline: marketA.map((candle) => candle.candleTimeUtc),
    config: {
      topN: 1,
      lookbackBars: 2,
      refreshEveryBars: 1
    }
  });

  const early = snapshots.get("2024-01-01T02:00:00.000Z");
  const later = snapshots.get("2024-01-01T04:00:00.000Z");

  assert.deepEqual(early?.marketCodes, ["KRW-A"]);
  assert.deepEqual(later?.marketCodes, ["KRW-B"]);
});

test("buildMarketStateContext derives liquiditySpread from rolling quote volume", () => {
  const marketHighNotional = createHourlyCandles({
    marketCode: "KRW-HIGH",
    closes: [1000, 1002, 1004, 1006, 1008, 1010],
    volumes: [100, 100, 100, 100, 100, 100]
  });
  const marketLowNotional = createHourlyCandles({
    marketCode: "KRW-LOW",
    closes: [10, 10.02, 10.04, 10.06, 10.08, 10.1],
    volumes: [100, 100, 100, 100, 100, 100]
  });
  const universeCandlesByMarket = {
    "KRW-HIGH": marketHighNotional,
    "KRW-LOW": marketLowNotional
  };
  const referenceTime = marketHighNotional[5].candleTimeUtc;
  const highContext = buildMarketStateContext({
    marketCode: "KRW-HIGH",
    referenceTime,
    universeName: "krw-top",
    universeCandlesByMarket
  });
  const lowContext = buildMarketStateContext({
    marketCode: "KRW-LOW",
    referenceTime,
    universeName: "krw-top",
    universeCandlesByMarket
  });

  assert.ok((highContext?.relativeStrength?.liquiditySpread ?? 0) > 0);
  assert.ok((lowContext?.relativeStrength?.liquiditySpread ?? 0) < 0);
});

test("buildMarketStateContext anchors regime to daily and weekly trend plus benchmark", () => {
  const benchmarkCandles = buildMacroDowntrendWithLateBounce({
    marketCode: "KRW-BTC",
    startPrice: 320,
    troughPrice: 110,
    bouncePrice: 122
  });
  const altCandles = buildMacroDowntrendWithLateBounce({
    marketCode: "KRW-ALT",
    startPrice: 210,
    troughPrice: 95,
    bouncePrice: 106
  });
  const context = buildMarketStateContext({
    marketCode: "KRW-ALT",
    referenceTime: altCandles[altCandles.length - 1]!.candleTimeUtc,
    universeName: "krw-top",
    universeCandlesByMarket: {
      "KRW-BTC": benchmarkCandles,
      "KRW-ALT": altCandles
    }
  });

  assert.equal(context?.benchmarkMarketCode, "KRW-BTC");
  assert.equal(context?.benchmark?.regime, "trend_down");
  assert.equal(context?.benchmark?.anchors?.daily?.regime, "trend_down");
  assert.equal(context?.benchmark?.anchors?.weekly?.regime, "trend_down");
  assert.equal(context?.composite?.anchors?.daily?.regime, "trend_down");
  assert.equal(context?.composite?.anchors?.weekly?.regime, "trend_down");
  assert.equal(context?.composite?.regime, "trend_down");
  assert.ok((context?.composite?.trendScore ?? 0) < 0);
});
