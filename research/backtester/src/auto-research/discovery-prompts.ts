import type {
  AutoResearchRunConfig,
  ResearchIterationRecord,
  StrategyFamilyDefinition
} from "./types.js";
import { compactFamilyPerformance } from "./prompt-builder.js";

const SYSTEM_PROMPT = `You are an autonomous crypto trading strategy researcher.
Operating on Upbit KRW spot market, long only, 0.05% fee per trade.
Optimize for net return after costs and robustness across walk-forward windows.`;

export function buildDiscoveryPrompt(params: {
  config: AutoResearchRunConfig;
  marketCodes: string[];
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  journalSummary?: { patterns: string[]; antiPatterns: string[]; recentEntries: string[] };
}): string {
  const { config, marketCodes, families, history, journalSummary } = params;
  const existingFamilies = families.map((f) => `- ${f.familyId}: ${f.title}`).join("\n");
  const performance = compactFamilyPerformance(history);
  const perfSummary = Object.entries(performance)
    .map(([fid, perf]) => `- ${fid}: ${perf.evaluations} evals, best=${perf.bestNetReturn?.toFixed(3) ?? "N/A"}`)
    .join("\n");

  const journal = journalSummary
    ? `\nResearch Journal:\nPatterns: ${journalSummary.patterns.join("; ") || "none yet"}\nAnti-patterns (avoid these): ${journalSummary.antiPatterns.join("; ") || "none yet"}\nRecent: ${journalSummary.recentEntries.slice(0, 5).join("; ") || "none yet"}\n`
    : "";

  return `${SYSTEM_PROMPT}

TASK: DISCOVERY — Propose new research ideas for profitable trading strategies.

Market: ${marketCodes.length} coins on Upbit KRW, timeframe ${config.timeframe}, ${config.limit} candles history.

Already explored:
${existingFamilies || "Nothing yet."}
${perfSummary ? `\nPerformance:\n${perfSummary}` : ""}
${journal}
Think broadly. A human researcher would consider:
1. Technical patterns — indicator combos, multi-timeframe confluence, adaptive parameters
2. Market microstructure — volume profile anomalies, spread dynamics, tick clustering
3. Cross-market — lead-lag between coins, correlation regime shifts, BTC dominance effects
4. Regime transitions — volatility breakout timing, trend reversal detection, range-bound optimization
5. Time effects — hour-of-day seasonality, day-of-week patterns, pre/post-announcement windows
6. Statistical edges — Z-score extremes, mean reversion timing, distribution tail events
7. Contrarian — overextended momentum reversals, extreme volume divergence
8. Multi-factor — composite scoring (momentum + volume + volatility), factor rotation

Each idea MUST have:
- A FALSIFIABLE thesis ("If X, then Y, because Z")
- A MECHANISM explaining WHY this edge exists
- Feasibility with available data (OHLCV + volume candles)

Available indicators: RSI, EMA, SMA, BollingerBands, MACD, ADX, ATR, CCI, Stochastic, ZScore, Momentum, ROC, DonchianChannel, OBV, VolumeSpikeRatio, HistoricalVolatility, RangeExpansionScore, MarketRegime

Return JSON (no markdown):
{"summary":"overview of research direction","ideas":[{"ideaId":"unique-slug","title":"short name","thesis":"falsifiable statement","mechanism":"why the edge exists","category":"category from above","dataRequirements":["what data needed"],"expectedEdge":"expected magnitude","riskNotes":["what could invalidate"],"indicators":["indicator names to use"]}]}`;
}

export function buildDesignPrompt(params: {
  idea: { ideaId: string; title: string; thesis: string; mechanism: string; indicators: string[] };
  config: AutoResearchRunConfig;
}): string {
  const { idea, config } = params;
  return `${SYSTEM_PROMPT}

TASK: DESIGN a concrete trading strategy from a research idea.

Idea: ${idea.title}
Thesis: ${idea.thesis}
Mechanism: ${idea.mechanism}
Suggested indicators: ${idea.indicators.join(", ")}

Design requirements:
- Entry: When to BUY (specific indicator conditions)
- Exit: When to SELL (take-profit, stop-loss, signal reversal)
- Conviction: How to set 0-1 confidence score
- Parameters: Tunable values with min/max ranges
- Regime gate: Which market regimes to activate in

Available indicators: RSI, EMA, SMA, BollingerBands, MACD, ADX, ATR, CCI, Stochastic, ZScore, Momentum, ROC, DonchianChannel, OBV, VolumeSpikeRatio, HistoricalVolatility, RangeExpansionScore, MarketRegime

Return JSON (no markdown):
{"familyId":"generated:${idea.ideaId}","strategyName":"generated-${idea.ideaId}","title":"descriptive name","thesis":"the thesis","family":"trend|breakout|micro|meanreversion","sleeveId":"trend|breakout|micro|reversion","decisionTimeframe":"${config.timeframe}","executionTimeframe":"5m","parameterSpecs":[{"name":"paramName","description":"what it controls","min":0,"max":100}],"regimeGate":{"allowedRegimes":["trend_up","range"]},"signalLogicDescription":"complete plain-English signal logic","indicators":["indicator function names"],"entryLogic":"pseudocode for BUY conditions","exitLogic":"pseudocode for SELL conditions"}`;
}

export function buildImplementationPrompt(params: {
  design: {
    familyId: string;
    strategyName: string;
    title: string;
    thesis: string;
    signalLogicDescription: string;
    entryLogic: string;
    exitLogic: string;
    indicators: string[];
    parameterSpecs: Array<{ name: string; description: string; min: number; max: number }>;
  };
  scaffoldCode: string;
}): string {
  const paramList = params.design.parameterSpecs.map((p) => `p.${p.name}`).join(", ");
  return `Write TypeScript signal logic for: ${params.design.title}

Entry: ${params.design.entryLogic}
Exit: ${params.design.exitLogic}

Available variables (ONLY use these, do NOT invent new ones):
- candles: Candle[] (OHLCV array, candles[idx] = current bar)
- idx: number (current bar index)
- hasPosition: boolean
- entryPrice: number (0 if no position)
- barsHeld: number (hours since entry, 0 if no position)
- p.paramName: parameter values (prefixed with p.)
Indicator functions: ${params.design.indicators.join(", ")}
Usage: functionName(candles, idx, period) — all take (candles[], endIndex, period) and return number|null
Example: const rsi = getRsi(candles, idx, p.rsiPeriod) ?? 50;
Candle fields: .openPrice, .highPrice, .lowPrice, .closePrice, .volume (NOT .open/.close)

Return ONLY a TypeScript code block (no explanation) that sets signal/conviction/reason:
- signal: "BUY" | "SELL" | "HOLD"
- conviction: 0-1
- reason: string
- First check: if (idx < 30) keep HOLD
- Use EXACTLY these parameter names with "p." prefix: ${paramList}
- Do NOT invent new parameter names. Only use the ones listed above.

Example format:
const rsi = getRsi(candles.slice(0, idx + 1), p.rsiPeriod);
if (!hasPosition && rsi < p.oversold) { signal = "BUY"; conviction = 0.7; reason = "RSI oversold"; }
if (hasPosition && rsi > p.overbought) { signal = "SELL"; conviction = 0.8; reason = "RSI overbought"; }`;
}
