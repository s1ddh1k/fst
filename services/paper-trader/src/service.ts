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
  listPaperPositions,
  listActiveStrategyRegimeSnapshots,
  listPaperSessions,
  loadActiveStrategyRegimes,
  loadStrategyRegimeById
} from "./db.js";
import type { PaperSessionRow, StrategyRegimeRow, StrategyRegimeSnapshotRow } from "./types.js";

function getDefaultSessionMarketCode(recommendation: StrategyRegimeRow, requestedMarketCode?: string): string {
  if (recommendation.strategyType === "single") {
    if (!requestedMarketCode) {
      throw new Error("--market is required for single-market recommendations");
    }

    return requestedMarketCode;
  }

  return `UNIVERSE:${recommendation.universeName}`;
}

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
  marketCode?: string;
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
      universeName: recommendation.universeName,
      timeframe: recommendation.timeframe,
      strategyType: recommendation.strategyType,
      strategyNames: recommendation.strategyNames,
      parameters: recommendation.parametersJson,
      weights: recommendation.weightsJson,
      avgTrainReturn: recommendation.avgTrainReturn,
      avgTestReturn: recommendation.avgTestReturn,
      avgTestDrawdown: recommendation.avgTestDrawdown
    },
    marketCode: getDefaultSessionMarketCode(recommendation, params.marketCode),
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
  positions: Awaited<ReturnType<typeof listPaperPositions>>;
  recentOrders: Awaited<ReturnType<typeof getLatestPaperOrders>>;
}> {
  const session = await getPaperSession(sessionId);

  if (!session) {
    return {
      session: null,
      position: null,
      positions: [],
      recentOrders: []
    };
  }

  const positions = await listPaperPositions(sessionId);
  const position = session.marketCode.startsWith("UNIVERSE:")
    ? null
    : await getPaperPosition({
        sessionId,
        marketCode: session.marketCode
      });
  const recentOrders = await getLatestPaperOrders(sessionId, 10);

  return {
    session,
    position,
    positions,
    recentOrders
  };
}

export async function getRecommendationForSession(
  session: PaperSessionRow,
  params?: {
    regimeName?: string;
    universeName?: string;
  }
): Promise<StrategyRegimeRow | null> {
  const sessionParameters =
    session.parametersJson && typeof session.parametersJson === "object"
      ? (session.parametersJson as Record<string, unknown>)
      : {};
  const recommendationId =
    typeof sessionParameters.recommendationId === "number"
      ? sessionParameters.recommendationId
      : Number(sessionParameters.recommendationId);

  if (Number.isFinite(recommendationId) && recommendationId > 0) {
    const recommendation = await loadStrategyRegimeById(recommendationId);

    if (recommendation) {
      return recommendation;
    }
  }

  const recommendations = await getRecommendations({
    regimeName: params?.regimeName,
    universeName: params?.universeName,
    timeframe: session.timeframe,
    limit: 20
  });

  return (
    recommendations.find((item) => item.strategyNames.join(" + ") === session.strategyName) ??
    recommendations[0] ??
    null
  );
}
