import {
  getBollingerBands,
  getRsi,
  getAtr
} from "./factors/index.js";
import type {
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
}): ScoredStrategy {
  const bbWindow = params?.bbWindow ?? 20;
  const bbMultiplier = params?.bbMultiplier ?? 2;
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const exitRsi = params?.exitRsi ?? 50;
  const stopLossPct = params?.stopLossPct ?? 0.30;
  const maxHoldBars = params?.maxHoldBars ?? 168; // 168 1h bars = 7 days
  const entryPercentB = params?.entryPercentB ?? 0.05; // near/below lower band

  const parameters: Record<string, number> = {
    bbWindow,
    bbMultiplier,
    rsiPeriod,
    exitRsi,
    stopLossPct,
    maxHoldBars,
    entryPercentB
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
    parameterCount: 7,
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
        const regimeExitRsi =
          regime === "trend_up" ? exitRsi + 10 :
          regime === "trend_down" ? exitRsi - 10 :
          regime === "range" ? exitRsi - 5 :
          exitRsi;

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

        // 4. Price returned to/above BB middle band (trend_up: let it run past middle)
        if (regime !== "trend_up" && close >= bb.middle) {
          return sell(0.8, "bb_middle_band_reached", "signal_exit");
        }
        // In trend_up, only exit at upper half of BB range
        if (regime === "trend_up" && close >= bb.middle + (bb.upper - bb.middle) * 0.3) {
          return sell(0.75, "bb_upper_zone_reached", "signal_exit");
        }

        // 5. Profit taking: if price recovered significantly
        if (pnl > 0.05 && rsi >= regimeExitRsi * 0.85) {
          return sell(0.75, "profit_taking_partial_reversion", "signal_exit");
        }

        return hold("waiting_for_reversion");
      }

      // --- ENTRY LOGIC ---
      // Price at or below BB lower band (percentB near 0 = at lower band)
      const atLowerBand = bb.percentB <= entryPercentB;
      // RSI confirms oversold
      const rsiOversold = rsi < 35;
      // Band width is meaningful (not squeezed)
      const bandWidthOk = bb.width > 0.02;

      if (!atLowerBand) {
        return hold("price_above_bb_lower", {
          metrics: { percentB: bb.percentB, rsi, bbWidth: bb.width }
        });
      }

      if (!bandWidthOk) {
        return hold("bb_squeezed", {
          metrics: { percentB: bb.percentB, rsi, bbWidth: bb.width }
        });
      }

      // Conviction: stronger when more oversold
      const bbConviction = clamp01(1 - bb.percentB / entryPercentB);
      const rsiConviction = rsiOversold ? clamp01((35 - rsi) / 20) : 0.2;
      const conviction = clamp01(0.5 * bbConviction + 0.3 * rsiConviction + 0.2);

      return buy(Math.max(0.55, conviction), "bb_lower_band_touch", {
        tags: rsiOversold ? ["bb_oversold", "rsi_oversold"] : ["bb_oversold"],
        metrics: {
          percentB: bb.percentB,
          rsi,
          bbWidth: bb.width,
          bbLower: bb.lower,
          bbMiddle: bb.middle
        }
      });
    }
  };
}
