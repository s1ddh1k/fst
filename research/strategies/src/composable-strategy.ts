import type { Signal, Strategy, StrategyContext } from "./types.js";

export type Rule = (context: StrategyContext) => boolean;

export function createComposableStrategy(params: {
  name: string;
  parameters: Record<string, number>;
  entryRule: Rule;
  filterRules?: Rule[];
  exitRule: Rule;
}): Strategy {
  const filterRules = params.filterRules ?? [];

  return {
    name: params.name,
    parameters: params.parameters,
    generateSignal(context: StrategyContext): Signal {
      if (!context.hasPosition) {
        const passesFilters = filterRules.every((rule) => rule(context));

        if (passesFilters && params.entryRule(context)) {
          return "BUY";
        }
      }

      if (context.hasPosition && params.exitRule(context)) {
        return "SELL";
      }

      return "HOLD";
    }
  };
}
