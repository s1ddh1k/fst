export type StrategyTimeframe = "1m" | "5m" | "15m" | "1h";

export type Candle = {
  marketCode: string;
  timeframe: StrategyTimeframe | string;
  candleTimeUtc: Date;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  quoteVolume?: number;
  isSynthetic?: boolean;
};

export type Signal = "BUY" | "SELL" | "HOLD";
export type OrderSide = "BUY" | "SELL";

export type PositionView = {
  market: string;
  quantity: number;
  entryPrice: number;
  entryTime: Date;
  sleeveId: string;
  strategyId: string;
  lastUpdateTime: Date;
};

export type AccountView = {
  equity: number;
  cash: number;
  capitalInUse: number;
};

export type UniverseSnapshot = {
  asOf: Date;
  timeframe: StrategyTimeframe | string;
  markets: string[];
  metricByMarket: Record<string, number>;
};
