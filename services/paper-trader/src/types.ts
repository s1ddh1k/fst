export type StrategyRegimeRow = {
  id: number;
  regimeName: string;
  universeName: string;
  timeframe: string;
  holdoutDays: number;
  strategyType: string;
  strategyNames: string[];
  parametersJson: unknown;
  weightsJson: unknown;
  marketCount: number;
  avgTrainReturn: number;
  avgTestReturn: number;
  avgTestDrawdown: number;
  rank: number;
};

export type StrategyRegimeSnapshotRow = {
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
  trainStartAt: Date | null;
  trainEndAt: Date | null;
  testStartAt: Date | null;
  testEndAt: Date | null;
  recommendationCount: number;
  bestAvgTestReturn: number;
  worstAvgTestDrawdown: number;
  generatedAt: Date;
  updatedAt: Date;
};

export type PaperSessionRow = {
  id: number;
  strategyName: string;
  marketCode: string;
  timeframe: string;
  startingBalance: number;
  currentBalance: number;
  status: string;
  startedAt: Date;
  parametersJson: unknown;
};

export type PaperPositionRow = {
  id: number;
  paperSessionId: number;
  marketCode: string;
  quantity: number;
  avgEntryPrice: number;
  markPrice: number | null;
  unrealizedPnl: number;
  realizedPnl: number;
  updatedAt: Date;
};

export type PaperOrderRow = {
  marketCode: string | null;
  side: string;
  executedPrice: number | null;
  quantity: number;
  fee: number;
  status: string;
  executedAt: Date | null;
};
