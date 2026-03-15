import type { Trade, BootstrapResult } from "./types.js";

function extractTradeReturns(trades: Trade[]): number[] {
  const returns: number[] = [];

  for (let i = 1; i < trades.length; i += 2) {
    const buy = trades[i - 1];
    const sell = trades[i];

    if (buy.side === "BUY" && sell.side === "SELL" && buy.price > 0) {
      const grossReturn = (sell.price - buy.price) / buy.price;
      const feeImpact = (buy.fee + sell.fee) / (buy.price * buy.quantity);
      returns.push(grossReturn - feeImpact);
    }
  }

  return returns;
}

function sampleWithReplacement(values: number[], count: number): number[] {
  const result = new Array<number>(count);

  for (let i = 0; i < count; i += 1) {
    result[i] = values[Math.floor(Math.random() * values.length)];
  }

  return result;
}

function totalReturn(returns: number[]): number {
  let equity = 1;

  for (const r of returns) {
    equity *= 1 + r;
  }

  return equity - 1;
}

export function runBootstrapValidation(params: {
  trades: Trade[];
  parameterCount: number;
  iterations?: number;
}): BootstrapResult {
  const iterations = params.iterations ?? 5000;
  const tradeReturns = extractTradeReturns(params.trades);
  const tradeCount = tradeReturns.length;
  const observed = totalReturn(tradeReturns);
  const ratio = params.parameterCount === 0 ? tradeCount : tradeCount / params.parameterCount;

  if (tradeCount < 3) {
    return {
      observedReturn: observed,
      meanReturn: 0,
      confidence95Lower: 0,
      confidence95Upper: 0,
      pValue: 1,
      isSignificant: false,
      tradeToParameterRatio: ratio,
      passesMinRatio: ratio >= 10
    };
  }

  const bootstrapReturns: number[] = [];

  for (let i = 0; i < iterations; i += 1) {
    const sample = sampleWithReplacement(tradeReturns, tradeCount);
    bootstrapReturns.push(totalReturn(sample));
  }

  bootstrapReturns.sort((a, b) => a - b);

  const lowerIdx = Math.floor(iterations * 0.025);
  const upperIdx = Math.floor(iterations * 0.975);
  const mean = bootstrapReturns.reduce((s, v) => s + v, 0) / iterations;
  const belowZeroCount = bootstrapReturns.filter((r) => r <= 0).length;
  const pValue = belowZeroCount / iterations;

  return {
    observedReturn: observed,
    meanReturn: mean,
    confidence95Lower: bootstrapReturns[lowerIdx],
    confidence95Upper: bootstrapReturns[upperIdx],
    pValue,
    isSignificant: pValue < 0.05,
    tradeToParameterRatio: ratio,
    passesMinRatio: ratio >= 10
  };
}
