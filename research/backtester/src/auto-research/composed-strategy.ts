import type { ScoredStrategy, SignalResult, StrategyContext } from "../../../strategies/src/types.js";
import type { ResolvedStrategyFamilyComposition } from "./types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toDirectionalScore(result: SignalResult): number {
  if (result.signal === "BUY") {
    return result.conviction;
  }

  if (result.signal === "SELL") {
    return -result.conviction;
  }

  return 0;
}

export function createComposedScoredStrategy(params: {
  name: string;
  parameters: Record<string, number>;
  composition: ResolvedStrategyFamilyComposition;
  createComponent: (strategyName: string, parameters?: Record<string, number>) => ScoredStrategy;
}): ScoredStrategy {
  const components = params.composition.components.map((component) => {
    const boundParameters = Object.entries(component.parameterBindings).reduce<Record<string, number>>(
      (result, [componentParam, familyParam]) => {
        const value = params.parameters[familyParam];
        if (Number.isFinite(value)) {
          result[componentParam] = value;
        }
        return result;
      },
      {}
    );

    return {
      ...component,
      strategy: params.createComponent(component.strategyName, boundParameters)
    };
  });

  return {
    name: params.name,
    parameters: params.parameters,
    parameterCount: Object.keys(params.parameters).length,
    generateSignal(context: StrategyContext): SignalResult {
      const componentResults = components.map((component) => ({
        component,
        result: component.strategy.generateSignal(context)
      }));

      const totalWeight = componentResults.reduce((sum, item) => sum + item.component.weight, 0) || 1;
      const weightedScore = componentResults.reduce(
        (sum, item) => sum + toDirectionalScore(item.result) * item.component.weight,
        0
      );
      const normalizedScore = weightedScore / totalWeight;

      if (params.composition.mode === "confirmatory") {
        const primary = componentResults[0];
        const confirmations = componentResults.slice(1);
        const confirmationWeight = confirmations.reduce((sum, item) => {
          if (primary?.result.signal === "BUY" && item.result.signal === "BUY") {
            return sum + item.component.weight;
          }
          if (primary?.result.signal === "SELL" && item.result.signal === "SELL") {
            return sum + item.component.weight;
          }
          return sum;
        }, 0);
        const normalizedConfirmation = confirmationWeight / Math.max(totalWeight - (primary?.component.weight ?? 0), 1);

        if (primary?.result.signal === "BUY" && normalizedConfirmation >= params.composition.buyThreshold) {
          return {
            signal: "BUY",
            conviction: clamp((primary.result.conviction + normalizedConfirmation) / 2, 0, 1),
            metadata: {
              reason: "composition_confirmed_buy",
              tags: ["composition", "confirmatory"],
              metrics: {
                weightedScore: normalizedScore,
                confirmationScore: normalizedConfirmation
              }
            }
          };
        }

        if (primary?.result.signal === "SELL" && normalizedConfirmation >= params.composition.sellThreshold) {
          return {
            signal: "SELL",
            conviction: clamp((primary.result.conviction + normalizedConfirmation) / 2, 0, 1),
            metadata: {
              reason: "composition_confirmed_sell",
              tags: ["composition", "confirmatory"],
              metrics: {
                weightedScore: normalizedScore,
                confirmationScore: normalizedConfirmation
              }
            }
          };
        }
      }

      if (normalizedScore >= params.composition.buyThreshold) {
        return {
          signal: "BUY",
          conviction: clamp(normalizedScore, 0, 1),
          metadata: {
            reason: "composition_weighted_buy",
            tags: ["composition", params.composition.mode],
            metrics: {
              weightedScore: normalizedScore
            }
          }
        };
      }

      if (normalizedScore <= -params.composition.sellThreshold) {
        return {
          signal: "SELL",
          conviction: clamp(Math.abs(normalizedScore), 0, 1),
          metadata: {
            reason: "composition_weighted_sell",
            tags: ["composition", params.composition.mode],
            metrics: {
              weightedScore: normalizedScore
            }
          }
        };
      }

      return {
        signal: "HOLD",
        conviction: clamp(Math.abs(normalizedScore), 0, 1),
        metadata: {
          reason: "composition_hold",
          tags: ["composition", params.composition.mode],
          metrics: {
            weightedScore: normalizedScore
          }
        }
      };
    }
  };
}
