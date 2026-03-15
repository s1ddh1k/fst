export type ExecutionModel = {
  name: string;
  getExecutionPrice(params: {
    side: "BUY" | "SELL";
    openPrice: number;
    slippageRate: number;
  }): number;
};

export function createBarOpenExecutionModel(): ExecutionModel {
  return {
    name: "bar-open-slippage",
    getExecutionPrice(params) {
      return params.side === "BUY"
        ? params.openPrice * (1 + params.slippageRate)
        : params.openPrice * (1 - params.slippageRate);
    }
  };
}
