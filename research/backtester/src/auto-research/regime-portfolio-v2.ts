import type {
  Strategy,
  StrategyContext,
  StrategySignal,
  StrategySleeveConfig,
  StrategyTimeframe
} from "../../../../packages/shared/src/index.js";
import type { Candle } from "../types.js";
import { adaptScoredStrategy, runMultiStrategyBacktest } from "../multi-strategy/index.js";
import { createVolumeExhaustionBounceStrategy } from "../../../strategies/src/simple-strategies.js";
import { createRelativeStrengthRotationStrategy } from "../multi-strategy/index.js";
import {
  buildMacroRegimeSeries,
  resolveMacroRegimeAtTime,
  resolveMacroScoreAtTime,
  scoreCoin,
  type MacroRegime
} from "./regime-system.js";

type CandleMap = Record<string, Candle[]>;

export type RegimePortfolioV2Config = {
  candlesByTimeframeAndMarket: Record<string, CandleMap>;
  initialCapital: number;
  marketCodes: string[];
  maxOpenPositions?: number;
};

function applyMacroRouter(params: {
  strategy: Strategy;
  benchmarkCandles: Candle[];
  macroRegimes: MacroRegime[];
  allowEntryWhen: MacroRegime[];
  forceExitWhenDisallowed?: MacroRegime[];
  holdPositionsWhenBlocked?: boolean;
  microFloor?: number;
  bullExposureBaseScale?: number;
  bullExposureBonusScale?: number;
}): Strategy {
  return {
    ...params.strategy,
    generateSignal(context: StrategyContext): StrategySignal {
      const macro = resolveMacroRegimeAtTime({
        benchmarkCandles: params.benchmarkCandles,
        stableRegimes: params.macroRegimes,
        decisionTime: context.decisionTime
      });
      const allowed = params.allowEntryWhen.includes(macro);
      const rawMacroScore = resolveMacroScoreAtTime({
        benchmarkCandles: params.benchmarkCandles,
        decisionTime: context.decisionTime
      });
      const bullStrength = Math.max(0, Math.min(1, (rawMacroScore - 4) / 4));
      const bullExposureScale = macro === "bull"
        ? Math.min(1, (params.bullExposureBaseScale ?? 1) + bullStrength * (params.bullExposureBonusScale ?? 0))
        : 1;
      const micro = scoreCoin(context);
      const hasPosition = Boolean(context.existingPosition);
      const shouldForceExit = params.forceExitWhenDisallowed?.includes(macro) ?? true;

      if (!allowed) {
        if (hasPosition && params.holdPositionsWhenBlocked && !shouldForceExit) {
          const signal = params.strategy.generateSignal(context);
          return {
            ...signal,
            signal: signal.signal === "BUY" ? "HOLD" : signal.signal,
            reason: signal.signal === "BUY" ? `macro_hold_${macro}` : signal.reason,
            stages: {
              ...signal.stages,
              regime_pass: false
            },
            metadata: {
              ...signal.metadata,
              macroRegime: macro,
              microQuality: micro.quality,
              macroScore: rawMacroScore,
              bullExposureScale,
              microDirection: micro.direction,
              relativeStrength: micro.signals.relativeStrength,
              volumeSpike: micro.signals.volumeSpike,
              rsi: micro.signals.rsi,
              smaDistance: micro.signals.smaDistance
            }
          };
        }

        return {
          strategyId: params.strategy.id,
          sleeveId: params.strategy.sleeveId,
          family: params.strategy.family,
          market: context.market,
          signal: hasPosition && shouldForceExit ? "SELL" : "HOLD",
          conviction: hasPosition && shouldForceExit ? 0.7 : 0,
          decisionTime: context.decisionTime,
          decisionTimeframe: params.strategy.decisionTimeframe,
          executionTimeframe: params.strategy.executionTimeframe,
          reason: hasPosition && shouldForceExit ? `macro_exit_${macro}` : `macro_block_${macro}`,
          stages: {
            universe_eligible: true,
            regime_pass: false,
            trigger_pass: hasPosition && shouldForceExit
          },
          metadata: {
            macroRegime: macro,
            microQuality: micro.quality,
            macroScore: rawMacroScore,
            bullExposureScale,
            microDirection: micro.direction,
            relativeStrength: micro.signals.relativeStrength,
            volumeSpike: micro.signals.volumeSpike,
            rsi: micro.signals.rsi,
            smaDistance: micro.signals.smaDistance
          }
        };
      }

      const signal = params.strategy.generateSignal(context);
      if (signal.signal === "BUY" && params.microFloor !== undefined && micro.quality < params.microFloor) {
        return {
          ...signal,
          signal: "HOLD",
          conviction: micro.quality,
          reason: "micro_quality_block",
          stages: {
            ...signal.stages,
            regime_pass: true,
            trigger_pass: false
          },
          metadata: {
            ...signal.metadata,
            macroRegime: macro,
            microQuality: micro.quality,
            macroScore: rawMacroScore,
            bullExposureScale,
            microDirection: micro.direction,
            relativeStrength: micro.signals.relativeStrength,
            volumeSpike: micro.signals.volumeSpike,
            rsi: micro.signals.rsi,
            smaDistance: micro.signals.smaDistance
          }
        };
      }

      return {
        ...signal,
        conviction: signal.signal === "HOLD"
          ? signal.conviction
          : Math.max(0.05, Math.min(1, ((signal.conviction + micro.quality) / 2) * bullExposureScale)),
        stages: {
          ...signal.stages,
          regime_pass: true
        },
        metadata: {
          ...signal.metadata,
          macroRegime: macro,
          microQuality: micro.quality,
          macroScore: rawMacroScore,
          bullExposureScale,
          microDirection: micro.direction,
          relativeStrength: micro.signals.relativeStrength,
          volumeSpike: micro.signals.volumeSpike,
          rsi: micro.signals.rsi,
          smaDistance: micro.signals.smaDistance
        }
      };
    }
  };
}

export function runRegimePortfolioV2(config: RegimePortfolioV2Config) {
  const { candlesByTimeframeAndMarket, initialCapital, marketCodes } = config;
  const benchmarkCandles = candlesByTimeframeAndMarket["1h"]?.["KRW-BTC"] ?? [];
  const enableBearSleeve = false;
  const macroRegimes = buildMacroRegimeSeries(benchmarkCandles, {
    bullThreshold: 4,
    bearThreshold: -4,
    cooldownBars: 60
  });

  const trendUpStrategy = applyMacroRouter({
    strategy: createRelativeStrengthRotationStrategy({
      strategyId: "regime-rotation",
      rebalanceBars: 5,
      entryFloor: 0.52,
      reEntryCooldownBars: 2,
      exitFloor: 0.43,
      switchGap: 0.05,
      minAboveTrendRatio: 0,
      minLiquidityScore: 0.02,
      minCompositeTrend: -1,
      skipInternalRegimeCheck: true
    }),
    benchmarkCandles,
    macroRegimes,
    allowEntryWhen: ["bull"],
    forceExitWhenDisallowed: ["bear"],
    holdPositionsWhenBlocked: true,
    microFloor: 0.56,
    bullExposureBaseScale: 0.6,
    bullExposureBonusScale: 0.4
  });

  const trendDownStrategy = enableBearSleeve
    ? applyMacroRouter({
        strategy: adaptScoredStrategy({
          strategyId: "regime-vex-1h",
          sleeveId: "micro",
          family: "meanreversion",
          decisionTimeframe: "1h",
          executionTimeframe: "1h",
          scoredStrategy: createVolumeExhaustionBounceStrategy({
            dropLookback: 5,
            dropThresholdPct: 0.06,
            volumeWindow: 20,
            volumeSpikeMult: 2.5,
            rsiPeriod: 14,
            rsiEntry: 20,
            profitTargetPct: 0.025
          })
        }),
        benchmarkCandles,
        macroRegimes,
        allowEntryWhen: ["bear"]
      })
    : null;
  const sleeves: StrategySleeveConfig[] = [
    { sleeveId: "trend", capitalBudgetPct: 0.54, maxOpenPositions: 5, maxSinglePositionPct: 0.17, priority: 10 },
    ...(enableBearSleeve
      ? [{ sleeveId: "micro", capitalBudgetPct: 0.15, maxOpenPositions: 3, maxSinglePositionPct: 0.18, priority: 9 } satisfies StrategySleeveConfig]
      : [])
  ];

  return runMultiStrategyBacktest({
    universeName: "krw-top",
    initialCapital,
    strategies: [trendUpStrategy, trendDownStrategy].filter((strategy): strategy is Strategy => strategy !== null),
    sleeves,
    decisionCandles: candlesByTimeframeAndMarket as Record<StrategyTimeframe, CandleMap>,
    executionCandles: candlesByTimeframeAndMarket as Record<StrategyTimeframe, CandleMap>,
    marketStateConfig: { useAdaptiveRegime: true },
    universeConfig: {
      topN: Math.min(30, marketCodes.length),
      lookbackBars: 24 * 28,
      refreshEveryBars: 4,
      minHistoryBars: 24 * 120
    },
    captureTraceArtifacts: false,
    captureUniverseSnapshots: false,
    maxOpenPositions: config.maxOpenPositions ?? 5,
    maxCapitalUsagePct: 0.78,
    cooldownBarsAfterLoss: 8,
    minBarsBetweenEntries: 1
  });
}
