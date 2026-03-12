import {
  DEFAULT_REGIME_NAME,
  DEFAULT_TIMEFRAME,
  DEFAULT_UNIVERSE_NAME,
  PAPER_STARTING_BALANCE
} from "./config.js";
import {
  createPaperSession,
  getLatestPaperOrders,
  getPaperPosition,
  getPaperSession,
  listActiveStrategyRegimeSnapshots,
  listPaperSessions,
  loadActiveStrategyRegimes
} from "./db.js";
import type { PaperSessionRow, StrategyRegimeRow, StrategyRegimeSnapshotRow } from "./types.js";

export async function getRecommendations(params?: {
  regimeName?: string;
  universeName?: string;
  timeframe?: string;
  limit?: number;
}): Promise<StrategyRegimeRow[]> {
  return loadActiveStrategyRegimes({
    regimeName: params?.regimeName ?? DEFAULT_REGIME_NAME,
    universeName: params?.universeName ?? DEFAULT_UNIVERSE_NAME,
    timeframe: params?.timeframe ?? DEFAULT_TIMEFRAME,
    limit: params?.limit ?? 5
  });
}

export async function getRecentPaperSessions(limit = 20): Promise<PaperSessionRow[]> {
  return listPaperSessions(limit);
}

export async function getRecommendationSnapshots(limit = 20): Promise<StrategyRegimeSnapshotRow[]> {
  return listActiveStrategyRegimeSnapshots(limit);
}

export async function startRecommendedPaperSession(params: {
  marketCode: string;
  rank?: number;
  regimeName?: string;
  universeName?: string;
  timeframe?: string;
  startingBalance?: number;
}): Promise<{ recommendation: StrategyRegimeRow; session: PaperSessionRow }> {
  const recommendations = await getRecommendations({
    regimeName: params.regimeName,
    universeName: params.universeName,
    timeframe: params.timeframe,
    limit: Math.max(params.rank ?? 1, 5)
  });

  const recommendation =
    recommendations.find((item) => item.rank === (params.rank ?? 1)) ?? recommendations[0];

  if (!recommendation) {
    throw new Error("No active strategy recommendation found");
  }

  const session = await createPaperSession({
    strategyName: recommendation.strategyNames.join(" + "),
    parametersJson: {
      recommendationId: recommendation.id,
      regimeName: recommendation.regimeName,
      strategyType: recommendation.strategyType,
      strategyNames: recommendation.strategyNames,
      parameters: recommendation.parametersJson,
      weights: recommendation.weightsJson,
      avgTrainReturn: recommendation.avgTrainReturn,
      avgTestReturn: recommendation.avgTestReturn,
      avgTestDrawdown: recommendation.avgTestDrawdown
    },
    marketCode: params.marketCode,
    timeframe: recommendation.timeframe,
    startingBalance: params.startingBalance ?? PAPER_STARTING_BALANCE
  });

  return {
    recommendation,
    session
  };
}

export async function getPaperSessionById(sessionId: number): Promise<PaperSessionRow | null> {
  return getPaperSession(sessionId);
}

export async function getPaperSessionStatus(sessionId: number): Promise<{
  session: PaperSessionRow | null;
  position: Awaited<ReturnType<typeof getPaperPosition>>;
  recentOrders: Awaited<ReturnType<typeof getLatestPaperOrders>>;
}> {
  const session = await getPaperSession(sessionId);

  if (!session) {
    return {
      session: null,
      position: null,
      recentOrders: []
    };
  }

  const position = await getPaperPosition({
    sessionId,
    marketCode: session.marketCode
  });
  const recentOrders = await getLatestPaperOrders(sessionId, 10);

  return {
    session,
    position,
    recentOrders
  };
}
