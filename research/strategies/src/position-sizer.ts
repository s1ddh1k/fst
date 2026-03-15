import type { PositionSizer } from "./types.js";

export function createVolatilityTargetSizer(params?: {
  targetVolatility?: number;
  maxWeight?: number;
  minWeight?: number;
}): PositionSizer {
  const targetVolatility = Math.max(0.0001, params?.targetVolatility ?? 0.02);
  const maxWeight = Math.min(1, Math.max(0.01, params?.maxWeight ?? 0.95));
  const minWeight = Math.min(maxWeight, Math.max(0, params?.minWeight ?? 0.05));

  return {
    name: "volatility-target",
    calculate(request) {
      if (request.conviction <= 0 || request.atr <= 0 || request.currentPrice <= 0) {
        return { targetWeight: 0, reason: "invalid-input" };
      }

      const currentVolatility = request.atr / request.currentPrice;

      if (currentVolatility <= 0) {
        return { targetWeight: 0, reason: "zero-volatility" };
      }

      const rawWeight = (targetVolatility / currentVolatility) * request.conviction;
      const clampedWeight = Math.max(minWeight, Math.min(maxWeight, rawWeight));

      return {
        targetWeight: clampedWeight,
        reason: `vol=${(currentVolatility * 100).toFixed(2)}% conv=${request.conviction.toFixed(2)}`
      };
    }
  };
}

export function createFixedWeightSizer(weight?: number): PositionSizer {
  const fixedWeight = weight ?? 1;

  return {
    name: "fixed-weight",
    calculate(request) {
      if (request.conviction <= 0) {
        return { targetWeight: 0, reason: "no-conviction" };
      }

      return {
        targetWeight: fixedWeight * request.conviction,
        reason: `fixed=${fixedWeight} conv=${request.conviction.toFixed(2)}`
      };
    }
  };
}
