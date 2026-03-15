export type Locale = "ko" | "en";

export type Recommendation = {
  id: number;
  rank: number;
  strategyNames: string[];
  strategyType: string;
  avgTestReturn: number;
  avgTestDrawdown: number;
  marketCount: number;
  timeframe: string;
  parametersJson: unknown;
};

export type ScoredValidation = {
  bootstrapPassRate: number;
  randomPassRate: number;
  avgTestTradeCount: number;
};

export type Session = {
  id: number;
  strategyName: string;
  marketCode: string;
  timeframe: string;
  startingBalance: number;
  currentBalance: number;
  status: string;
  startedAt?: string;
};

export type Position = {
  marketCode?: string;
  quantity: number;
  avgEntryPrice: number;
  markPrice: number | null;
  unrealizedPnl: number;
  realizedPnl: number;
};

export type Order = {
  marketCode?: string | null;
  side: string;
  executedPrice: number | null;
  quantity: number;
  fee: number;
  status: string;
  executedAt: string | null;
};

export type SessionDetailPayload = {
  session: Session;
  position: Position | null;
  positions: Position[];
  recentOrders: Order[];
};

export type DictionaryKey = keyof typeof import("./i18n").dictionaries.ko;
