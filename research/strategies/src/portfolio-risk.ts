import type { PortfolioRiskManager } from "./types.js";

export function createDrawdownCircuitBreaker(params?: {
  warnThreshold?: number;
  killThreshold?: number;
  cooldownBars?: number;
  reducedExposure?: number;
}): PortfolioRiskManager {
  const warnThreshold = params?.warnThreshold ?? 0.05;
  const killThreshold = params?.killThreshold ?? 0.10;
  const cooldownBars = params?.cooldownBars ?? 48;
  const reducedExposure = params?.reducedExposure ?? 0.3;

  let peakEquity = 0;
  let cooldownRemaining = 0;
  let initialized = false;

  return {
    name: "drawdown-circuit-breaker",

    check(input) {
      if (!initialized) {
        peakEquity = input.peakEquity;
        initialized = true;
      }

      if (cooldownRemaining > 0) {
        return {
          canOpenNew: false,
          mustLiquidateAll: false,
          maxExposure: 0,
          reason: `cooldown: ${cooldownRemaining} bars remaining`
        };
      }

      const peak = Math.max(peakEquity, input.peakEquity);
      const drawdown = peak === 0 ? 0 : (peak - input.currentEquity) / peak;

      if (drawdown >= killThreshold) {
        cooldownRemaining = cooldownBars;
        return {
          canOpenNew: false,
          mustLiquidateAll: true,
          maxExposure: 0,
          reason: `kill: drawdown=${(drawdown * 100).toFixed(1)}% >= ${(killThreshold * 100).toFixed(0)}%`
        };
      }

      if (drawdown >= warnThreshold) {
        return {
          canOpenNew: false,
          mustLiquidateAll: false,
          maxExposure: reducedExposure,
          reason: `warn: drawdown=${(drawdown * 100).toFixed(1)}% >= ${(warnThreshold * 100).toFixed(0)}%`
        };
      }

      return {
        canOpenNew: true,
        mustLiquidateAll: false,
        maxExposure: 1,
        reason: "ok"
      };
    },

    onBarClose(equity) {
      peakEquity = Math.max(peakEquity, equity);

      if (cooldownRemaining > 0) {
        cooldownRemaining -= 1;
      }
    }
  };
}

export function createNoOpRiskManager(): PortfolioRiskManager {
  return {
    name: "no-op",
    check() {
      return {
        canOpenNew: true,
        mustLiquidateAll: false,
        maxExposure: 1,
        reason: "disabled"
      };
    },
    onBarClose() {}
  };
}
