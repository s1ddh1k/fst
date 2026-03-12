type ComparisonRow = {
  strategyName: string;
  marketCode: string;
  trainReturn: number;
  testReturn: number;
  testDrawdown: number;
  testWinRate: number;
  testTradeCount: number;
};

type RankingRow = {
  strategyName: string;
  parameters: string;
  marketCount: number;
  avgTrainReturn: number;
  avgTestReturn: number;
  avgTestDrawdown: number;
};

type WalkForwardRankingRow = {
  strategyName: string;
  parameters: string;
  marketCount: number;
  averageWindows: number;
  avgTrainReturn: number;
  avgTestReturn: number;
  avgTestDrawdown: number;
  avgTestTradeCount: number;
};

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function formatComparisonTable(rows: ComparisonRow[]): string {
  const headers = [
    "strategy",
    "market",
    "train_return",
    "test_return",
    "test_mdd",
    "test_win_rate",
    "test_trades"
  ];

  const tableRows = rows.map((row) => [
    row.strategyName,
    row.marketCode,
    formatPercent(row.trainReturn),
    formatPercent(row.testReturn),
    formatPercent(row.testDrawdown),
    formatPercent(row.testWinRate),
    String(row.testTradeCount)
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...tableRows.map((row) => row[index].length))
  );

  const lines = [
    headers.map((header, index) => header.padEnd(widths[index])).join(" | "),
    widths.map((width) => "-".repeat(width)).join("-|-")
  ];

  for (const row of tableRows) {
    lines.push(row.map((cell, index) => cell.padEnd(widths[index])).join(" | "));
  }

  return lines.join("\n");
}

export function formatRankingTable(rows: RankingRow[]): string {
  const headers = [
    "strategy",
    "parameters",
    "markets",
    "avg_train_return",
    "avg_test_return",
    "avg_test_mdd"
  ];

  const tableRows = rows.map((row) => [
    row.strategyName,
    row.parameters,
    String(row.marketCount),
    formatPercent(row.avgTrainReturn),
    formatPercent(row.avgTestReturn),
    formatPercent(row.avgTestDrawdown)
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...tableRows.map((row) => row[index].length))
  );

  const lines = [
    headers.map((header, index) => header.padEnd(widths[index])).join(" | "),
    widths.map((width) => "-".repeat(width)).join("-|-")
  ];

  for (const row of tableRows) {
    lines.push(row.map((cell, index) => cell.padEnd(widths[index])).join(" | "));
  }

  return lines.join("\n");
}

export function formatPortfolioRankingTable(
  rows: Array<{
    strategies: string;
    markets: number;
    avgTrainReturn: number;
    avgTestReturn: number;
    avgTestDrawdown: number;
  }>
): string {
  const headers = ["strategies", "markets", "avg_train_return", "avg_test_return", "avg_test_mdd"];
  const tableRows = rows.map((row) => [
    row.strategies,
    String(row.markets),
    formatPercent(row.avgTrainReturn),
    formatPercent(row.avgTestReturn),
    formatPercent(row.avgTestDrawdown)
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...tableRows.map((row) => row[index].length))
  );
  const lines = [
    headers.map((header, index) => header.padEnd(widths[index])).join(" | "),
    widths.map((width) => "-".repeat(width)).join("-|-")
  ];

  for (const row of tableRows) {
    lines.push(row.map((cell, index) => cell.padEnd(widths[index])).join(" | "));
  }

  return lines.join("\n");
}

export function formatWalkForwardRankingTable(rows: WalkForwardRankingRow[]): string {
  const headers = [
    "strategy",
    "parameters",
    "markets",
    "avg_windows",
    "avg_train_return",
    "avg_test_return",
    "avg_test_mdd",
    "avg_test_trades"
  ];

  const tableRows = rows.map((row) => [
    row.strategyName,
    row.parameters,
    String(row.marketCount),
    row.averageWindows.toFixed(1),
    formatPercent(row.avgTrainReturn),
    formatPercent(row.avgTestReturn),
    formatPercent(row.avgTestDrawdown),
    row.avgTestTradeCount.toFixed(2)
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...tableRows.map((row) => row[index].length))
  );

  const lines = [
    headers.map((header, index) => header.padEnd(widths[index])).join(" | "),
    widths.map((width) => "-".repeat(width)).join("-|-")
  ];

  for (const row of tableRows) {
    lines.push(row.map((cell, index) => cell.padEnd(widths[index])).join(" | "));
  }

  return lines.join("\n");
}
