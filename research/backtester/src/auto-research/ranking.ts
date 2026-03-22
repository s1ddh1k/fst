import type { CandidateBacktestEvaluation } from "./types.js";

export const DEFAULT_MIN_NET_RETURN_FOR_PROMOTION = 0.05;
const DEFAULT_MAX_DRAWDOWN_FOR_PROMOTION = 0.35;
const DEFAULT_MIN_RANDOM_PERCENTILE_FOR_PROMOTION = 0.5;

function positiveWindowRatio(evaluation: CandidateBacktestEvaluation): number {
  return evaluation.diagnostics.windows.positiveWindowRatio ?? 0;
}

export function resolveEvaluationTradeCount(evaluation: CandidateBacktestEvaluation): number {
  return evaluation.diagnostics.windows.totalClosedTrades ?? evaluation.summary.tradeCount;
}

export function resolveEvaluationMaxDrawdown(
  evaluation: CandidateBacktestEvaluation
): number {
  return evaluation.diagnostics.windows.worstWindowMaxDrawdown ?? evaluation.summary.maxDrawdown;
}

function worstWindowNetReturn(evaluation: CandidateBacktestEvaluation): number {
  return evaluation.diagnostics.windows.worstWindowNetReturn ?? evaluation.summary.netReturn;
}

function windowCount(evaluation: CandidateBacktestEvaluation): number {
  return evaluation.diagnostics.windows.windowCount ?? 0;
}

function tradefulScore(evaluation: CandidateBacktestEvaluation): number {
  return resolveEvaluationTradeCount(evaluation) > 0 ? 1 : 0;
}

function profitabilityTier(evaluation: CandidateBacktestEvaluation): number {
  if (evaluation.summary.netReturn > 0) {
    return 1;
  }
  if (evaluation.summary.netReturn < 0) {
    return -1;
  }
  return 0;
}

function randomPercentile(evaluation: CandidateBacktestEvaluation): number | undefined {
  const value =
    evaluation.summary.randomPercentile ??
    evaluation.diagnostics.robustness.randomPercentile;

  return Number.isFinite(value) ? Number(value) : undefined;
}

function bootstrapSignificant(evaluation: CandidateBacktestEvaluation): boolean | undefined {
  const value =
    evaluation.summary.bootstrapSignificant ??
    evaluation.diagnostics.robustness.bootstrapSignificant;

  return typeof value === "boolean" ? value : undefined;
}

export function calculateCandidateRiskAdjustedScore(
  evaluation: CandidateBacktestEvaluation
): number {
  if (evaluation.status !== "completed") {
    return Number.NEGATIVE_INFINITY;
  }

  const trades = resolveEvaluationTradeCount(evaluation);
  const windows = windowCount(evaluation);
  const percentile = randomPercentile(evaluation);
  const maxDrawdown = resolveEvaluationMaxDrawdown(evaluation);

  let score = evaluation.summary.netReturn;
  score -= maxDrawdown * 1.25;
  score += positiveWindowRatio(evaluation) * 0.15;
  score += worstWindowNetReturn(evaluation) * 0.35;
  score += Math.min(trades, 20) * 0.0025;
  score += Math.min(windows, 12) * 0.003;

  if (tradefulScore(evaluation) === 0) {
    score -= 0.25;
  }

  if (bootstrapSignificant(evaluation)) {
    score += 0.04;
  }

  if (percentile !== undefined) {
    score += (percentile - 0.5) * 0.12;
  }

  return Number(score.toFixed(6));
}

export function passesPromotionGate(
  evaluation: CandidateBacktestEvaluation,
  config?: {
    minTrades?: number;
    minNetReturn?: number;
    maxDrawdown?: number;
    minPositiveWindowRatio?: number;
    minRandomPercentile?: number;
    requireBootstrapSignificance?: boolean;
  }
): boolean {
  if (evaluation.status !== "completed") {
    return false;
  }

  if (
    config?.minTrades !== undefined &&
    resolveEvaluationTradeCount(evaluation) < config.minTrades
  ) {
    return false;
  }

  const minNetReturn = config?.minNetReturn ?? DEFAULT_MIN_NET_RETURN_FOR_PROMOTION;
  if (evaluation.summary.netReturn <= minNetReturn) {
    return false;
  }

  const maxDrawdown = config?.maxDrawdown ?? DEFAULT_MAX_DRAWDOWN_FOR_PROMOTION;
  if (resolveEvaluationMaxDrawdown(evaluation) > maxDrawdown) {
    return false;
  }

  const percentile = randomPercentile(evaluation);
  const minRandomPercentile =
    config?.minRandomPercentile ?? DEFAULT_MIN_RANDOM_PERCENTILE_FOR_PROMOTION;
  if (percentile !== undefined && percentile < minRandomPercentile) {
    return false;
  }

  if (
    config?.minPositiveWindowRatio !== undefined &&
    windowCount(evaluation) > 0 &&
    positiveWindowRatio(evaluation) < config.minPositiveWindowRatio
  ) {
    return false;
  }

  if (
    config?.requireBootstrapSignificance &&
    bootstrapSignificant(evaluation) !== true
  ) {
    return false;
  }

  return true;
}

export function compareCandidateEvaluations(
  left: CandidateBacktestEvaluation,
  right: CandidateBacktestEvaluation
): number {
  if (left.status !== right.status) {
    return left.status === "failed" ? 1 : -1;
  }

  const leftTradeful = tradefulScore(left);
  const rightTradeful = tradefulScore(right);
  if (leftTradeful !== rightTradeful) {
    return rightTradeful - leftTradeful;
  }

  const leftProfitabilityTier = profitabilityTier(left);
  const rightProfitabilityTier = profitabilityTier(right);
  if (leftProfitabilityTier !== rightProfitabilityTier) {
    return rightProfitabilityTier - leftProfitabilityTier;
  }

  if (
    leftProfitabilityTier < 0 &&
    rightProfitabilityTier < 0 &&
    right.summary.netReturn !== left.summary.netReturn
  ) {
    return right.summary.netReturn - left.summary.netReturn;
  }

  const leftPositiveWindowRatio = positiveWindowRatio(left);
  const rightPositiveWindowRatio = positiveWindowRatio(right);
  if (leftPositiveWindowRatio !== rightPositiveWindowRatio) {
    return rightPositiveWindowRatio - leftPositiveWindowRatio;
  }

  const leftRiskAdjustedScore = calculateCandidateRiskAdjustedScore(left);
  const rightRiskAdjustedScore = calculateCandidateRiskAdjustedScore(right);
  if (leftRiskAdjustedScore !== rightRiskAdjustedScore) {
    return rightRiskAdjustedScore - leftRiskAdjustedScore;
  }

  const leftWorstWindow = worstWindowNetReturn(left);
  const rightWorstWindow = worstWindowNetReturn(right);
  if (leftWorstWindow !== rightWorstWindow) {
    return rightWorstWindow - leftWorstWindow;
  }

  const leftWindowCount = windowCount(left);
  const rightWindowCount = windowCount(right);
  if (leftWindowCount !== rightWindowCount) {
    return rightWindowCount - leftWindowCount;
  }

  if (right.summary.netReturn !== left.summary.netReturn) {
    return right.summary.netReturn - left.summary.netReturn;
  }

  const leftClosedTrades = resolveEvaluationTradeCount(left);
  const rightClosedTrades = resolveEvaluationTradeCount(right);
  if (leftClosedTrades !== rightClosedTrades) {
    return rightClosedTrades - leftClosedTrades;
  }

  const leftMaxDrawdown = resolveEvaluationMaxDrawdown(left);
  const rightMaxDrawdown = resolveEvaluationMaxDrawdown(right);
  if (leftMaxDrawdown !== rightMaxDrawdown) {
    return leftMaxDrawdown - rightMaxDrawdown;
  }

  return right.summary.tradeCount - left.summary.tradeCount;
}

export function summarizeEvaluationRanking(evaluation: CandidateBacktestEvaluation) {
  return {
    tradeful: resolveEvaluationTradeCount(evaluation) > 0,
    riskAdjustedScore: calculateCandidateRiskAdjustedScore(evaluation),
    netReturn: evaluation.summary.netReturn,
    maxDrawdown: resolveEvaluationMaxDrawdown(evaluation),
    tradeCount: resolveEvaluationTradeCount(evaluation),
    positiveWindowRatio: positiveWindowRatio(evaluation),
    worstWindowNetReturn: worstWindowNetReturn(evaluation),
    windowCount: windowCount(evaluation),
    totalClosedTrades: resolveEvaluationTradeCount(evaluation),
    randomPercentile: randomPercentile(evaluation),
    bootstrapSignificant: bootstrapSignificant(evaluation)
  };
}
