export type Candle = {
  marketCode: string;
  timeframe: string;
  candleTimeUtc: Date;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
};

export type Signal = "BUY" | "SELL" | "HOLD";

export type StrategyContext = {
  candles: Candle[];
  index: number;
  hasPosition: boolean;
};

export type Strategy = {
  name: string;
  parameters: Record<string, number>;
  generateSignal(context: StrategyContext): Signal;
};
