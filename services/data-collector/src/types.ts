export type Market = {
  market: string;
  korean_name: string;
  english_name: string;
  market_event?: {
    warning?: boolean;
    caution?: Record<string, boolean>;
  };
};

export type Ticker = {
  market: string;
  acc_trade_price_24h: number;
};

export type UpbitCandle = {
  market: string;
  candle_date_time_utc: string;
  candle_date_time_kst: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  timestamp: number;
  candle_acc_trade_price: number;
  candle_acc_trade_volume: number;
};

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "1d";

export type CandleRequest = {
  market: string;
  timeframe: Timeframe;
  count?: number;
  to?: string;
};

export type CollectorRun = {
  id: number;
  status: string;
};
