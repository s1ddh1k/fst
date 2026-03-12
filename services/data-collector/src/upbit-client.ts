import { REQUEST_RETRY_COUNT, REQUEST_RETRY_DELAY_MS, UPBIT_REST_BASE_URL } from "./config.js";
import {
  registerRateLimitHit,
  registerResponseQuota,
  waitForQuota
} from "./rate-limiter.js";
import type { CandleRequest, Market, Ticker, Timeframe, UpbitCandle } from "./types.js";
import { sleep } from "./utils.js";

function getCandlePath(timeframe: Timeframe): string {
  switch (timeframe) {
    case "1m":
      return "/candles/minutes/1";
    case "5m":
      return "/candles/minutes/5";
    case "1h":
      return "/candles/minutes/60";
    case "1d":
      return "/candles/days";
  }
}

export class UpbitClient {
  private async requestJson<T>(url: URL, group = "default"): Promise<T> {
    let lastError: Error | null = null;
    let currentGroup = group;

    for (let attempt = 1; attempt <= REQUEST_RETRY_COUNT; attempt += 1) {
      try {
        await waitForQuota(currentGroup, sleep);

        const response = await fetch(url);

        currentGroup = await registerResponseQuota(response.headers.get("Remaining-Req"), sleep);

        if (response.status === 429) {
          await registerRateLimitHit(currentGroup, attempt, sleep);
          throw new Error("Upbit rate limit exceeded (429)");
        }

        if (response.status >= 500) {
          throw new Error(`Upbit server error: ${response.status} ${response.statusText}`);
        }

        if (!response.ok) {
          throw new Error(`Upbit request failed: ${response.status} ${response.statusText}`);
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < REQUEST_RETRY_COUNT) {
          await sleep(REQUEST_RETRY_DELAY_MS * attempt);
        }
      }
    }

    throw lastError ?? new Error("Unknown Upbit request failure");
  }

  async getMarkets(): Promise<Market[]> {
    const url = new URL(`${UPBIT_REST_BASE_URL}/market/all`);
    url.searchParams.set("isDetails", "true");
    return this.requestJson<Market[]>(url, "market");
  }

  async getTickersByQuote(quoteCurrencies: string[]): Promise<Ticker[]> {
    const url = new URL(`${UPBIT_REST_BASE_URL}/ticker/all`);
    url.searchParams.set("quote_currencies", quoteCurrencies.join(","));
    return this.requestJson<Ticker[]>(url, "ticker");
  }

  async getCandles(request: CandleRequest): Promise<UpbitCandle[]> {
    const url = new URL(`${UPBIT_REST_BASE_URL}${getCandlePath(request.timeframe)}`);

    url.searchParams.set("market", request.market);

    if (request.count !== undefined) {
      url.searchParams.set("count", String(request.count));
    }

    if (request.to) {
      url.searchParams.set("to", request.to);
    }

    return this.requestJson<UpbitCandle[]>(url, "candle");
  }
}
