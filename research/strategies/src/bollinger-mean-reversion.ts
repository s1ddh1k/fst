import {
  getBollingerBands,
  getMacd,
  getRsi,
  getAtr
} from "./factors/index.js";
import type {
  CompositeBenchmarkRegime,
  MarketStateConfig,
  ScoredStrategy,
  SignalResult,
  StrategyContext
} from "./types.js";
import { buy, hold, sell } from "./scored-signal.js";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function averageOrNull(values: Array<number | null | undefined>): number | null {
  const finiteValues = values.filter((value): value is number => Number.isFinite(value));
  if (finiteValues.length === 0) {
    return null;
  }

  return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
}

function directionalRegimeScore(regime: CompositeBenchmarkRegime | undefined): number | null {
  switch (regime) {
    case "trend_up":
      return 1;
    case "range":
      return 0.45;
    case "volatile":
      return 0.3;
    case "trend_down":
      return 0;
    default:
      return null;
  }
}

function computeVolumeFadeScore(
  candles: StrategyContext["candles"],
  index: number,
  lookbackBars: number
): number | null {
  const current = candles[index];
  if (!current) {
    return null;
  }

  const startIndex = Math.max(0, index - lookbackBars);
  const priorCandles = candles.slice(startIndex, index).filter((candle) => candle.volume > 0);
  if (priorCandles.length < 2) {
    return null;
  }

  const averagePriorVolume =
    priorCandles.reduce((sum, candle) => sum + candle.volume, 0) / priorCandles.length;
  const peakPriorVolume = Math.max(...priorCandles.map((candle) => candle.volume));
  if (averagePriorVolume <= 0 || peakPriorVolume <= 0) {
    return null;
  }

  const currentToAverage = current.volume / averagePriorVolume;
  const currentToPeak = current.volume / peakPriorVolume;

  return averageOrNull([
    clamp01((1 - currentToAverage) / 0.6),
    clamp01((1 - currentToPeak) / 0.75)
  ]);
}

function computeReversalCandleScore(candle: StrategyContext["candles"][number] | undefined): number | null {
  if (!candle) {
    return null;
  }

  const range = candle.highPrice - candle.lowPrice;
  if (!Number.isFinite(range) || range <= 0) {
    return null;
  }

  const upperWick = candle.highPrice - Math.max(candle.openPrice, candle.closePrice);
  const weakCloseDistance = candle.highPrice - candle.closePrice;
  const bearishBody = Math.max(0, candle.openPrice - candle.closePrice);

  return averageOrNull([
    clamp01((upperWick / range) / 0.45),
    clamp01((weakCloseDistance / range) / 0.6),
    clamp01((bearishBody / range) / 0.35)
  ]);
}

function computeMomentumDecayScore(
  candles: StrategyContext["candles"],
  index: number,
  rsiPeriod: number
): number | null {
  if (index <= 0) {
    return null;
  }

  const close = candles[index]?.closePrice;
  const currentRsi = getRsi(candles, index, rsiPeriod);
  const previousRsi = getRsi(candles, index - 1, rsiPeriod);
  const currentMacd = getMacd(candles, index, {
    fastWindow: 12,
    slowWindow: 26,
    signalWindow: 9
  });
  const previousMacd = getMacd(candles, index - 1, {
    fastWindow: 12,
    slowWindow: 26,
    signalWindow: 9
  });

  const rsiDecay =
    currentRsi === null || previousRsi === null
      ? null
      : clamp01((previousRsi - currentRsi) / 6);
  const macdDecay =
    close === undefined || close <= 0 || currentMacd === null || previousMacd === null
      ? null
      : clamp01((previousMacd.histogram - currentMacd.histogram) / Math.max(close * 0.0025, 0.0001));

  return averageOrNull([rsiDecay, macdDecay]);
}

function computeBenchmarkWeaknessScore(
  marketState: StrategyContext["marketState"]
): number | null {
  if (!marketState) {
    return null;
  }

  const benchmark = marketState.benchmark;
  const relativeStrength = marketState.relativeStrength;

  return averageOrNull([
    benchmark?.momentum === null || benchmark?.momentum === undefined
      ? null
      : clamp01((-benchmark.momentum) / 0.03),
    benchmark?.trendScore === null || benchmark?.trendScore === undefined
      ? null
      : clamp01((-benchmark.trendScore) / 0.25),
    relativeStrength?.benchmarkMomentumSpread === null ||
      relativeStrength?.benchmarkMomentumSpread === undefined
      ? null
      : clamp01((-relativeStrength.benchmarkMomentumSpread) / 0.03)
  ]);
}

function computeBenchmarkLeadScore(
  marketState: StrategyContext["marketState"]
): number | null {
  if (!marketState) {
    return null;
  }

  const benchmark = marketState.benchmark;
  const intraday = benchmark?.anchors?.intraday ?? benchmark;
  const daily = benchmark?.anchors?.daily;
  const weekly = benchmark?.anchors?.weekly;
  const benchmarkMomentumSpread = marketState.relativeStrength?.benchmarkMomentumSpread;
  const lagPreferenceScore =
    benchmarkMomentumSpread === null || benchmarkMomentumSpread === undefined
      ? null
      : clamp01(1 - Math.abs(benchmarkMomentumSpread + 0.006) / 0.03);

  return averageOrNull([
    intraday?.momentum === null || intraday?.momentum === undefined
      ? null
      : clamp01(intraday.momentum / 0.03),
    intraday?.trendScore === null || intraday?.trendScore === undefined
      ? null
      : clamp01(intraday.trendScore / 0.25),
    directionalRegimeScore(daily?.regime),
    directionalRegimeScore(weekly?.regime),
    lagPreferenceScore
  ]);
}

function computeRelativeFragilityScore(
  marketState: StrategyContext["marketState"]
): number | null {
  const relativeStrength = marketState?.relativeStrength;
  if (!relativeStrength) {
    return null;
  }

  return averageOrNull([
    relativeStrength.benchmarkMomentumSpread === null || relativeStrength.benchmarkMomentumSpread === undefined
      ? null
      : clamp01((-relativeStrength.benchmarkMomentumSpread - 0.002) / 0.03),
    relativeStrength.compositeMomentumSpread === null || relativeStrength.compositeMomentumSpread === undefined
      ? null
      : clamp01((-relativeStrength.compositeMomentumSpread - 0.002) / 0.03),
    relativeStrength.cohortMomentumSpread === null || relativeStrength.cohortMomentumSpread === undefined
      ? null
      : clamp01((-relativeStrength.cohortMomentumSpread - 0.002) / 0.03)
  ]);
}

function findRecentTouch(params: {
  candles: StrategyContext["candles"];
  index: number;
  bbWindow: number;
  bbMultiplier: number;
  entryPercentB: number;
  reclaimLookbackBars: number;
}): { index: number; closePrice: number; percentB: number; width: number } | null {
  const startIndex = Math.max(params.bbWindow - 1, params.index - params.reclaimLookbackBars);

  for (let offset = params.index - 1; offset >= startIndex; offset -= 1) {
    const bb = getBollingerBands(params.candles, offset, params.bbWindow, params.bbMultiplier);
    if (!bb) {
      continue;
    }

    if (bb.percentB <= params.entryPercentB) {
      return {
        index: offset,
        closePrice: params.candles[offset]!.closePrice,
        percentB: bb.percentB,
        width: bb.width
      };
    }
  }

  return null;
}

/**
 * 볼린저 밴드 하단 터치 매수 → RSI 평균 회귀 매도 전략.
 *
 * 진입: 종가가 볼린저 밴드 하단 이하 (과매도)
 * 청산:
 *   1. RSI가 exitRsi 이상 도달 (평균 회귀 완료)
 *   2. 종가가 볼린저 중간선 이상 도달 (밴드 평균 회귀)
 *   3. 손절: entryPrice 대비 -stopLossPct 하락
 *   4. 최대 보유 기간 초과
 */
export function createBollingerMeanReversionStrategy(params?: {
  bbWindow?: number;
  bbMultiplier?: number;
  rsiPeriod?: number;
  exitRsi?: number;
  stopLossPct?: number;
  maxHoldBars?: number;
  entryPercentB?: number;
  entryRsiThreshold?: number;
  requireRsiConfirmation?: boolean;
  requireReclaimConfirmation?: boolean;
  reclaimLookbackBars?: number;
  reclaimPercentBThreshold?: number;
  reclaimMinCloseBouncePct?: number;
  reclaimBandWidthFactor?: number;
  deepTouchEntryPercentB?: number;
  deepTouchRsiThreshold?: number;
  minBandWidth?: number;
  trendUpExitRsiOffset?: number;
  trendDownExitRsiOffset?: number;
  rangeExitRsiOffset?: number;
  trendUpExitBandFraction?: number;
  trendDownExitBandFraction?: number;
  volatileExitBandFraction?: number;
  profitTakePnlThreshold?: number;
  profitTakeBandWidthFactor?: number;
  trendDownProfitTargetScale?: number;
  volatileProfitTargetScale?: number;
  profitTakeRsiFraction?: number;
  entryBenchmarkLeadWeight?: number;
  entryBenchmarkLeadMinScore?: number;
  softExitScoreThreshold?: number;
  softExitMinPnl?: number;
  softExitMinBandFraction?: number;
  exitVolumeFadeWeight?: number;
  exitReversalWeight?: number;
  exitMomentumDecayWeight?: number;
  exitBenchmarkWeaknessWeight?: number;
  exitRelativeFragilityWeight?: number;
  exitTimeDecayWeight?: number;
}): ScoredStrategy {
  const bbWindow = params?.bbWindow ?? 20;
  const bbMultiplier = params?.bbMultiplier ?? 2;
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const exitRsi = params?.exitRsi ?? 50;
  const stopLossPct = params?.stopLossPct ?? 0.30;
  const maxHoldBars = params?.maxHoldBars ?? 168; // 168 1h bars = 7 days
  const entryPercentB = params?.entryPercentB ?? 0.05; // near/below lower band
  const entryRsiThreshold = params?.entryRsiThreshold ?? 35;
  const requireRsiConfirmation = params?.requireRsiConfirmation ?? false;
  const requireReclaimConfirmation = params?.requireReclaimConfirmation ?? false;
  const reclaimLookbackBars = params?.reclaimLookbackBars ?? 4;
  const reclaimPercentBThreshold = params?.reclaimPercentBThreshold ?? 0.15;
  const reclaimMinCloseBouncePct = params?.reclaimMinCloseBouncePct ?? 0.005;
  const reclaimBandWidthFactor = params?.reclaimBandWidthFactor ?? 0.1;
  const deepTouchEntryPercentB = params?.deepTouchEntryPercentB ?? Math.min(entryPercentB, -0.05);
  const deepTouchRsiThreshold = params?.deepTouchRsiThreshold ?? Math.max(10, entryRsiThreshold - 6);
  const minBandWidth = params?.minBandWidth ?? 0.02;
  const trendUpExitRsiOffset = params?.trendUpExitRsiOffset ?? 10;
  const trendDownExitRsiOffset = params?.trendDownExitRsiOffset ?? -10;
  const rangeExitRsiOffset = params?.rangeExitRsiOffset ?? -5;
  const trendUpExitBandFraction = params?.trendUpExitBandFraction ?? 0.3;
  const trendDownExitBandFraction = params?.trendDownExitBandFraction ?? 0.2;
  const volatileExitBandFraction = params?.volatileExitBandFraction ?? 0.45;
  const profitTakePnlThreshold = params?.profitTakePnlThreshold ?? 0.02;
  const profitTakeBandWidthFactor = params?.profitTakeBandWidthFactor ?? 0.75;
  const trendDownProfitTargetScale = params?.trendDownProfitTargetScale ?? 0.55;
  const volatileProfitTargetScale = params?.volatileProfitTargetScale ?? 0.75;
  const profitTakeRsiFraction = params?.profitTakeRsiFraction ?? 0.85;
  const entryBenchmarkLeadWeight = params?.entryBenchmarkLeadWeight ?? 0;
  const entryBenchmarkLeadMinScore = params?.entryBenchmarkLeadMinScore ?? 0;
  const softExitScoreThreshold = params?.softExitScoreThreshold ?? 0.58;
  const softExitMinPnl = params?.softExitMinPnl ?? 0.015;
  const softExitMinBandFraction = params?.softExitMinBandFraction ?? 0.3;
  const exitVolumeFadeWeight = params?.exitVolumeFadeWeight ?? 0.22;
  const exitReversalWeight = params?.exitReversalWeight ?? 0.28;
  const exitMomentumDecayWeight = params?.exitMomentumDecayWeight ?? 0.22;
  const exitBenchmarkWeaknessWeight = params?.exitBenchmarkWeaknessWeight ?? 0.12;
  const exitRelativeFragilityWeight = params?.exitRelativeFragilityWeight ?? 0.16;
  const exitTimeDecayWeight = params?.exitTimeDecayWeight ?? 0.16;

  const parameters: Record<string, number> = {
    bbWindow,
    bbMultiplier,
    rsiPeriod,
    exitRsi,
    stopLossPct,
    maxHoldBars,
    entryPercentB,
    entryRsiThreshold,
    reclaimLookbackBars,
    reclaimPercentBThreshold,
    reclaimMinCloseBouncePct,
    reclaimBandWidthFactor,
    deepTouchEntryPercentB,
    deepTouchRsiThreshold,
    minBandWidth,
    trendUpExitRsiOffset,
    trendDownExitRsiOffset,
    rangeExitRsiOffset,
    trendUpExitBandFraction,
    trendDownExitBandFraction,
    volatileExitBandFraction,
    profitTakePnlThreshold,
    profitTakeBandWidthFactor,
    trendDownProfitTargetScale,
    volatileProfitTargetScale,
    profitTakeRsiFraction,
    entryBenchmarkLeadWeight,
    entryBenchmarkLeadMinScore,
    softExitScoreThreshold,
    softExitMinPnl,
    softExitMinBandFraction,
    exitVolumeFadeWeight,
    exitReversalWeight,
    exitMomentumDecayWeight,
    exitBenchmarkWeaknessWeight,
    exitRelativeFragilityWeight,
    exitTimeDecayWeight
  };

  const contextConfig: MarketStateConfig = {
    trendWindow: 50,
    momentumLookback: 20,
    volumeWindow: 20,
    zScoreWindow: 20
  };

  return {
    name: "bollinger-mean-reversion",
    parameters,
    parameterCount: Object.keys(parameters).length,
    contextConfig,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition, marketState } = context;
      const close = candles[index]?.closePrice;
      const bb = getBollingerBands(candles, index, bbWindow, bbMultiplier);
      const rsi = getRsi(candles, index, rsiPeriod);
      const atr = getAtr(candles, index, 14);

      if (close === undefined || bb === null || rsi === null || atr === null) {
        return hold("insufficient_context");
      }

      // --- EXIT LOGIC ---
      if (hasPosition && currentPosition) {
        const pnl = (close - currentPosition.entryPrice) / currentPosition.entryPrice;
        const composite = marketState?.composite;
        const regime = composite?.regime ?? "unknown";

        // Regime-adaptive exit RSI:
        // 상승장: exitRsi + 10 (더 오래 보유, 상승 모멘텀 활용)
        // 하락장: exitRsi - 10 (빨리 탈출)
        // 횡보장: exitRsi - 5 (평균보다 약간 못 미쳐도 매도)
        const regimeExitRsi = clamp(
          regime === "trend_up"
            ? exitRsi + trendUpExitRsiOffset
            : regime === "trend_down"
              ? exitRsi + trendDownExitRsiOffset
              : regime === "range"
                ? exitRsi + rangeExitRsiOffset
                : exitRsi,
          5,
          95
        );

        // 1. Stop loss
        if (pnl <= -stopLossPct) {
          return sell(1.0, "stop_loss_hit", "stop_exit");
        }

        // 2. Max hold period
        if (currentPosition.barsHeld >= maxHoldBars) {
          return sell(0.7, "max_hold_exceeded", "signal_exit");
        }

        // 3. RSI regime-adaptive mean reversion target reached
        if (rsi >= regimeExitRsi) {
          return sell(0.85, "rsi_mean_reversion_target", "signal_exit", {
            metrics: { rsi, regimeExitRsi, regime: regime === "trend_up" ? 1 : regime === "trend_down" ? -1 : 0 }
          });
        }

        // 4. Price-based regime exit targets.
        const downtrendBandTarget = bb.lower + (bb.middle - bb.lower) * trendDownExitBandFraction;
        const volatileBandTarget = bb.lower + (bb.middle - bb.lower) * volatileExitBandFraction;

        if (regime === "trend_down" && close >= downtrendBandTarget) {
          return sell(0.78, "bb_dead_cat_bounce_target_reached", "signal_exit", {
            metrics: {
              bbLower: bb.lower,
              bbMiddle: bb.middle,
              downtrendBandTarget
            }
          });
        }

        if (regime === "volatile" && close >= volatileBandTarget) {
          return sell(0.78, "bb_volatile_rebound_target_reached", "signal_exit", {
            metrics: {
              bbLower: bb.lower,
              bbMiddle: bb.middle,
              volatileBandTarget
            }
          });
        }

        if (regime !== "trend_up" && close >= bb.middle) {
          return sell(0.8, "bb_middle_band_reached", "signal_exit");
        }

        // In trend_up, only exit at upper half of BB range
        if (regime === "trend_up" && close >= bb.middle + (bb.upper - bb.middle) * trendUpExitBandFraction) {
          return sell(0.75, "bb_upper_zone_reached", "signal_exit");
        }

        const lowerToMiddleSpan = Math.max(bb.middle - bb.lower, close * 0.0001);
        const bandReversionFraction = clamp01((close - bb.lower) / lowerToMiddleSpan);
        const softExitActivated =
          pnl >= softExitMinPnl ||
          (pnl >= 0 && bandReversionFraction >= softExitMinBandFraction);

        if (softExitActivated) {
          const volumeFadeScore = computeVolumeFadeScore(candles, index, 6);
          const reversalScore = computeReversalCandleScore(candles[index]);
          const momentumDecayScore = computeMomentumDecayScore(candles, index, rsiPeriod);
          const benchmarkWeaknessScore = computeBenchmarkWeaknessScore(marketState);
          const relativeFragilityScore = computeRelativeFragilityScore(marketState);
          const timeDecayScore = clamp01((currentPosition.barsHeld / Math.max(maxHoldBars, 1) - 0.3) / 0.7);

          const weightedScores: Array<{ weight: number; score: number | null }> = [
            { weight: exitVolumeFadeWeight, score: volumeFadeScore },
            { weight: exitReversalWeight, score: reversalScore },
            { weight: exitMomentumDecayWeight, score: momentumDecayScore },
            { weight: exitBenchmarkWeaknessWeight, score: benchmarkWeaknessScore },
            { weight: exitRelativeFragilityWeight, score: relativeFragilityScore },
            { weight: exitTimeDecayWeight, score: timeDecayScore }
          ].filter((entry) => entry.weight > 0);

          const softExitWeightTotal = weightedScores.reduce(
            (sum, entry) => sum + (entry.score === null ? 0 : entry.weight),
            0
          );
          const softExitScore =
            softExitWeightTotal > 0
              ? weightedScores.reduce(
                (sum, entry) => sum + (entry.score === null ? 0 : entry.weight * entry.score),
                0
              ) / softExitWeightTotal
              : null;

          if (softExitScore !== null && softExitScore >= softExitScoreThreshold) {
            return sell(0.72, "soft_exit_score_reached", "signal_exit", {
              metrics: {
                pnl,
                bandReversionFraction,
                softExitScore,
                softExitScoreThreshold,
                volumeFadeScore,
                reversalScore,
                momentumDecayScore,
                benchmarkWeaknessScore,
                relativeFragilityScore,
                timeDecayScore
              }
            });
          }
        }

        // 5. Profit taking: scale the target by Bollinger width so wider bands
        // can ask for a larger rebound while narrow bands still clear fees.
        const regimeProfitTargetScale = regime === "trend_down"
          ? trendDownProfitTargetScale
          : regime === "volatile"
            ? volatileProfitTargetScale
            : 1;
        const widthScaledProfitTarget = Math.max(
          profitTakePnlThreshold,
          bb.width * profitTakeBandWidthFactor * regimeProfitTargetScale
        );
        if (pnl > widthScaledProfitTarget && rsi >= regimeExitRsi * profitTakeRsiFraction) {
          return sell(0.75, "profit_taking_partial_reversion", "signal_exit", {
            metrics: {
              pnl,
              bbWidth: bb.width,
              widthScaledProfitTarget,
              profitTakeBandWidthFactor,
              regimeProfitTargetScale,
              regimeExitRsi
            }
          });
        }

        return hold("waiting_for_reversion");
      }

      // --- ENTRY LOGIC ---
      const recentTouch = findRecentTouch({
        candles,
        index,
        bbWindow,
        bbMultiplier,
        entryPercentB,
        reclaimLookbackBars
      });
      // Price at or below BB lower band (percentB near 0 = at lower band)
      const atLowerBand = bb.percentB <= entryPercentB;
      // RSI confirms oversold
      const rsiOversold = rsi < entryRsiThreshold;
      // Band width is meaningful (not squeezed)
      const bandWidthOk = bb.width > minBandWidth;
      const reclaimPercentBOk = bb.percentB >= reclaimPercentBThreshold;
      const reclaimBouncePctRequired = Math.max(
        reclaimMinCloseBouncePct,
        (recentTouch?.width ?? bb.width) * reclaimBandWidthFactor
      );
      const reclaimBounceOk = recentTouch !== null &&
        close >= recentTouch.closePrice * (1 + reclaimBouncePctRequired);
      const risingFromPreviousClose = index === 0 || close >= candles[index - 1]!.closePrice;
      const deepTouchEligible =
        atLowerBand &&
        bandWidthOk &&
        bb.percentB <= Math.min(entryPercentB, deepTouchEntryPercentB) &&
        rsi <= deepTouchRsiThreshold;

      if (!atLowerBand && !requireReclaimConfirmation) {
        return hold("price_above_bb_lower", {
          metrics: { percentB: bb.percentB, rsi, bbWidth: bb.width }
        });
      }

      if (deepTouchEligible) {
        const bbThresholdScale = Math.max(0.01, Math.abs(deepTouchEntryPercentB));
        const bbOvershoot = Math.max(0, Math.min(entryPercentB, deepTouchEntryPercentB) - bb.percentB);
        const bbConviction = clamp01(bbOvershoot / bbThresholdScale);
        const rsiScale = Math.max(6, deepTouchRsiThreshold * 0.75);
        const rsiConviction = clamp01((deepTouchRsiThreshold - rsi) / rsiScale);
        const conviction = clamp01(0.55 * bbConviction + 0.3 * rsiConviction + 0.25);

        return buy(Math.max(0.6, conviction), "bb_deep_touch_entry", {
          tags: ["bb_oversold", "rsi_oversold", "deep_touch"],
          metrics: {
            percentB: bb.percentB,
            rsi,
            bbWidth: bb.width,
            deepTouchEntryPercentB,
            deepTouchRsiThreshold
          }
        });
      }

      if (requireReclaimConfirmation && recentTouch === null) {
        return hold("bb_touch_not_found_for_reclaim", {
          metrics: {
            percentB: bb.percentB,
            rsi,
            bbWidth: bb.width,
            reclaimLookbackBars,
            reclaimPercentBThreshold,
            reclaimBandWidthFactor
          }
        });
      }

      if (requireRsiConfirmation && !rsiOversold) {
        return hold("rsi_not_oversold", {
          metrics: { percentB: bb.percentB, rsi, entryRsiThreshold, bbWidth: bb.width }
        });
      }

      if (!bandWidthOk) {
        return hold("bb_squeezed", {
          metrics: { percentB: bb.percentB, rsi, bbWidth: bb.width, minBandWidth }
        });
      }

      if (requireReclaimConfirmation && (!reclaimPercentBOk || !reclaimBounceOk || !risingFromPreviousClose)) {
        return hold("bb_reclaim_not_confirmed", {
          metrics: {
            percentB: bb.percentB,
            rsi,
            bbWidth: bb.width,
            reclaimPercentBThreshold,
            reclaimMinCloseBouncePct,
            reclaimBouncePctRequired,
            reclaimBandWidthFactor,
            recentTouchPercentB: recentTouch?.percentB ?? null,
            recentTouchAgeBars: recentTouch ? index - recentTouch.index : null
          }
        });
      }

      // Conviction: stronger when more oversold
      const bbThresholdScale = Math.max(0.01, Math.abs(entryPercentB));
      const bbOvershoot = Math.max(0, entryPercentB - bb.percentB);
      const bbConviction = clamp01(bbOvershoot / bbThresholdScale);
      const rsiScale = Math.max(6, entryRsiThreshold * 0.6);
      const rsiConviction = rsiOversold
        ? clamp01((entryRsiThreshold - rsi) / rsiScale)
        : 0.2;
      const benchmarkLeadScore = computeBenchmarkLeadScore(marketState);

      if (
        entryBenchmarkLeadMinScore > 0 &&
        benchmarkLeadScore !== null &&
        benchmarkLeadScore < entryBenchmarkLeadMinScore
      ) {
        return hold("benchmark_lead_not_supportive", {
          metrics: {
            percentB: bb.percentB,
            rsi,
            bbWidth: bb.width,
            benchmarkLeadScore,
            entryBenchmarkLeadMinScore
          }
        });
      }

      const benchmarkLeadAdjustment =
        benchmarkLeadScore === null
          ? 0
          : (benchmarkLeadScore - 0.5) * 2 * entryBenchmarkLeadWeight;
      const conviction = clamp01(0.5 * bbConviction + 0.3 * rsiConviction + 0.2 + benchmarkLeadAdjustment);

      return buy(Math.max(0.55, conviction), "bb_lower_band_touch", {
        tags: ["bb_oversold", "rsi_oversold"],
        metrics: {
          percentB: bb.percentB,
          rsi,
          bbWidth: bb.width,
          bbLower: bb.lower,
          bbMiddle: bb.middle,
          benchmarkLeadScore
        }
      });
    }
  };
}
