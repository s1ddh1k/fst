import type { MultiStrategyBacktestResult } from "./types.js";

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function formatMultiStrategyReport(result: MultiStrategyBacktestResult): string {
  const lines = [
    "metric                 | value",
    "-----------------------|----------------",
    `gross_return           | ${pct(result.metrics.grossReturn)}`,
    `net_return             | ${pct(result.metrics.netReturn)}`,
    `turnover               | ${pct(result.metrics.turnover)}`,
    `win_rate               | ${pct(result.metrics.winRate)}`,
    `avg_hold_bars          | ${result.metrics.avgHoldBars.toFixed(2)}`,
    `max_drawdown           | ${pct(result.metrics.maxDrawdown)}`,
    `fee_paid               | ${result.metrics.feePaid.toFixed(2)}`,
    `slippage_paid          | ${result.metrics.slippagePaid.toFixed(2)}`,
    `rejected_orders        | ${String(result.metrics.rejectedOrdersCount)}`,
    `cooldown_skips         | ${String(result.metrics.cooldownSkipsCount)}`,
    `signals                | ${String(result.metrics.signalCount)}`,
    `blocked_signals        | ${String(result.metrics.blockedSignalCount)}`,
    `open_positions         | ${String(result.metrics.openPositionCount)}`
  ];

  const strategyLines = Object.entries(result.strategyMetrics)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([strategyId, metrics]) =>
        `${strategyId.padEnd(23)} | raw=${String(metrics.rawSignals).padStart(4)} buy=${String(metrics.buySignals).padStart(4)} sell=${String(metrics.sellSignals).padStart(4)} blocked=${String(metrics.blockedSignals).padStart(4)} filled=${String(metrics.filledOrders).padStart(4)} rej=${String(metrics.rejectedOrders).padStart(4)}`
    );
  const sleeveLines = Object.entries(result.sleeveMetrics)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([sleeveId, metrics]) =>
        `${sleeveId.padEnd(23)} | intents=${String(metrics.intents).padStart(4)} fills=${String(metrics.fills).padStart(4)} blocked=${String(metrics.blockedSignals).padStart(4)}`
    );

  return [
    ...lines,
    "",
    "strategy                | summary",
    "------------------------|-------------------------------------------------------------",
    ...strategyLines,
    "",
    "sleeve                  | summary",
    "------------------------|--------------------------------------",
    ...sleeveLines
  ].join("\n");
}

export function formatMultiStrategyComparisonTable(
  rows: Array<{
    label: string;
    netReturn: number;
    maxDrawdown: number;
    turnover: number;
    winRate: number;
    blockedSignals: number;
  }>
): string {
  const headers = ["preset", "net_return", "max_dd", "turnover", "win_rate", "blocked"];
  const data = rows.map((row) => [
    row.label,
    pct(row.netReturn),
    pct(row.maxDrawdown),
    pct(row.turnover),
    pct(row.winRate),
    String(row.blockedSignals)
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...data.map((row) => row[index].length))
  );
  const lines = [
    headers.map((header, index) => header.padEnd(widths[index])).join(" | "),
    widths.map((width) => "-".repeat(width)).join("-|-")
  ];

  for (const row of data) {
    lines.push(row.map((cell, index) => cell.padEnd(widths[index])).join(" | "));
  }

  return lines.join("\n");
}
