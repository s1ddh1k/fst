import type {
  AlphaModel,
  MarketStateConfig,
  RiskModel,
  Strategy
} from "./types.js";

export function createExplicitStrategy(params: {
  name: string;
  parameters: Record<string, number>;
  alphaModel: AlphaModel;
  riskModel: RiskModel;
  contextConfig?: MarketStateConfig;
}): Strategy {
  return {
    name: params.name,
    parameters: params.parameters,
    contextConfig: params.contextConfig,
    generateSignal(context) {
      const alpha = params.alphaModel.evaluate(context);
      const decision = params.riskModel.decide({
        context,
        alpha
      });

      return decision.signal;
    }
  };
}
