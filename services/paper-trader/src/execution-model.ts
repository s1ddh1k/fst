export type PaperExecutionModel = {
  name: string;
  executeBuy(params: {
    cash: number;
    marketPrice: number;
    feeRate: number;
    slippageRate: number;
  }): {
    executedPrice: number;
    fee: number;
    quantity: number;
  };
  executeSell(params: {
    quantity: number;
    marketPrice: number;
    avgEntryPrice: number;
    feeRate: number;
    slippageRate: number;
  }): {
    executedPrice: number;
    fee: number;
    netValue: number;
    realizedTradePnl: number;
  };
};

export function createMarketOrderExecutionModel(): PaperExecutionModel {
  return {
    name: "market-order-slippage",
    executeBuy(params) {
      const executedPrice = params.marketPrice * (1 + params.slippageRate);
      const fee = params.cash * params.feeRate;
      const netCash = params.cash - fee;

      return {
        executedPrice,
        fee,
        quantity: netCash / executedPrice
      };
    },
    executeSell(params) {
      const executedPrice = params.marketPrice * (1 - params.slippageRate);
      const grossValue = params.quantity * executedPrice;
      const fee = grossValue * params.feeRate;
      const netValue = grossValue - fee;

      return {
        executedPrice,
        fee,
        netValue,
        realizedTradePnl:
          (executedPrice - params.avgEntryPrice) * params.quantity - fee
      };
    }
  };
}
