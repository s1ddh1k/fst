import { getDb } from "./sqlite.js";
import type { ScoredBacktestResult } from "./types.js";

export async function insertScoredBacktestMetrics(params: {
  backtestRunId: number;
  segmentType: string;
  result: ScoredBacktestResult;
}): Promise<void> {
  const db = getDb();
  const { result } = params;

  try {
    db.prepare(
      `
        INSERT INTO backtest_metrics (
          backtest_run_id,
          segment_type,
          total_return,
          gross_return,
          net_return,
          max_drawdown,
          win_rate,
          trade_count,
          turnover,
          avg_hold_bars,
          fee_paid,
          slippage_paid,
          rejected_orders_count,
          cooldown_skips_count,
          bootstrap_p_value,
          bootstrap_ci_lower,
          bootstrap_ci_upper,
          random_benchmark_percentile,
          trade_to_parameter_ratio,
          avg_position_weight,
          max_position_weight,
          circuit_breaker_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      params.backtestRunId,
      params.segmentType,
      result.metrics.totalReturn,
      result.metrics.grossReturn,
      result.metrics.netReturn,
      result.metrics.maxDrawdown,
      result.metrics.winRate,
      result.metrics.tradeCount,
      result.metrics.turnover,
      result.metrics.avgHoldBars,
      result.metrics.feePaid,
      result.metrics.slippagePaid,
      result.metrics.rejectedOrdersCount,
      result.metrics.cooldownSkipsCount,
      result.bootstrap?.pValue ?? null,
      result.bootstrap?.confidence95Lower ?? null,
      result.bootstrap?.confidence95Upper ?? null,
      result.randomBenchmark?.percentileVsRandom ?? null,
      result.bootstrap?.tradeToParameterRatio ?? null,
      result.averagePositionWeight,
      result.maxPositionWeight,
      result.circuitBreakerTriggered
    );
  } catch (error) {
    if (!(error instanceof Error) || !/gross_return|net_return|turnover|avg_hold_bars|fee_paid|slippage_paid|bootstrap_p_value|random_benchmark_percentile|avg_position_weight/.test(error.message)) {
      throw error;
    }

    db.prepare(
      `
        INSERT INTO backtest_metrics (
          backtest_run_id,
          segment_type,
          total_return,
          annualized_return,
          max_drawdown,
          sharpe_ratio,
          sortino_ratio,
          win_rate,
          profit_factor,
          trade_count
        )
        VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, ?)
      `
    ).run(
      params.backtestRunId,
      params.segmentType,
      result.metrics.totalReturn,
      result.metrics.maxDrawdown,
      result.metrics.winRate,
      result.metrics.tradeCount
    );
  }
}
