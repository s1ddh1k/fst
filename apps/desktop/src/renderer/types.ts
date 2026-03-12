export type Locale = "ko" | "en";

export type Recommendation = {
  id: number;
  rank: number;
  strategyNames: string[];
  avgTestReturn: number;
  avgTestDrawdown: number;
  marketCount: number;
  timeframe: string;
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
  quantity: number;
  avgEntryPrice: number;
  markPrice: number | null;
  unrealizedPnl: number;
  realizedPnl: number;
};

export type Order = {
  side: string;
  executedPrice: number | null;
  quantity: number;
  fee: number;
  status: string;
  executedAt: string | null;
};

export type RecommendationSnapshot = {
  regimeName: string;
  universeName: string;
  timeframe: string;
  holdoutDays: number;
  sourceLabel: string | null;
  trainingDays: number | null;
  stepDays: number | null;
  minMarkets: number | null;
  minTrades: number | null;
  candidatePoolSize: number | null;
  bestStrategyName: string | null;
  trainStartAt: string | null;
  trainEndAt: string | null;
  testStartAt: string | null;
  testEndAt: string | null;
  recommendationCount: number;
  bestAvgTestReturn: number;
  worstAvgTestDrawdown: number;
  generatedAt: string;
  updatedAt: string;
};

export type SessionDetailPayload = {
  session: Session;
  position: Position | null;
  recentOrders: Order[];
};

export type DictionaryKey = keyof typeof import("./i18n").dictionaries.ko;
