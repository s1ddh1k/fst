import type { Strategy } from "./types.js";

import { buildStrategyGrid } from "./parameter-grid.js";
import { listStrategyNames } from "./strategy-registry.js";

export function buildTwoStrategyPortfolios(): Array<
  Array<{ strategy: Strategy; weight: number }>
> {
  const names = listStrategyNames();
  const portfolios: Array<Array<{ strategy: Strategy; weight: number }>> = [];
  const weights = [
    [0.3, 0.7],
    [0.5, 0.5],
    [0.7, 0.3]
  ];

  for (let leftIndex = 0; leftIndex < names.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < names.length; rightIndex += 1) {
      const leftStrategies = buildStrategyGrid(names[leftIndex]).slice(0, 2);
      const rightStrategies = buildStrategyGrid(names[rightIndex]).slice(0, 2);

      for (const leftStrategy of leftStrategies) {
        for (const rightStrategy of rightStrategies) {
          for (const [leftWeight, rightWeight] of weights) {
            portfolios.push([
              { strategy: leftStrategy, weight: leftWeight },
              { strategy: rightStrategy, weight: rightWeight }
            ]);
          }
        }
      }
    }
  }

  return portfolios;
}
