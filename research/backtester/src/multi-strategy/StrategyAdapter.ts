import type {
  ScoredStrategy,
  StrategyContext as LegacyStrategyContext
} from "../../../strategies/src/types.js";
import type { StrategyContext, StrategySignal } from "../../../../packages/shared/src/index.js";
import type { Strategy, SleeveId } from "../../../../packages/shared/src/index.js";
import { timeframeToMs } from "./timeframe.js";

export function adaptScoredStrategy(params: {
  strategyId: string;
  sleeveId: SleeveId;
  family: Strategy["family"];
  decisionTimeframe: Strategy["decisionTimeframe"];
  executionTimeframe: Strategy["executionTimeframe"];
  scoredStrategy: ScoredStrategy;
}): Strategy {
  return {
    id: params.strategyId,
    sleeveId: params.sleeveId,
    family: params.family,
    decisionTimeframe: params.decisionTimeframe,
    executionTimeframe: params.executionTimeframe,
    parameters: params.scoredStrategy.parameters,
    generateSignal(context: StrategyContext): StrategySignal {
      const legacyContext: LegacyStrategyContext = {
        candles: context.featureView.candles,
        index: context.featureView.decisionIndex,
        hasPosition: context.existingPosition !== undefined,
        currentPosition: context.existingPosition
          ? {
              entryPrice: context.existingPosition.entryPrice,
              quantity: context.existingPosition.quantity,
              barsHeld: Math.max(
                0,
                Math.floor(
                  (context.decisionTime.getTime() - context.existingPosition.entryTime.getTime()) /
                    Math.max(1, timeframeToMs(params.decisionTimeframe))
                )
              )
            }
          : undefined,
        marketState: context.marketState as LegacyStrategyContext["marketState"]
      };
      const result = params.scoredStrategy.generateSignal(legacyContext);

      return {
        strategyId: params.strategyId,
        sleeveId: params.sleeveId,
        family: params.family,
        market: context.market,
        signal: result.signal,
        conviction: result.conviction,
        decisionTime: context.decisionTime,
        decisionTimeframe: params.decisionTimeframe,
        executionTimeframe: params.executionTimeframe,
        reason: result.signal === "BUY" ? "adapter_buy" : result.signal === "SELL" ? "adapter_sell" : "adapter_hold",
        stages: {
          universe_eligible: true,
          trigger_pass: result.signal !== "HOLD"
        }
      };
    }
  };
}
