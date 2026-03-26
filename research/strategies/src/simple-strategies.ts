/**
 * Simple strategies with 5-7 parameters each.
 *
 * These are designed to be actually searchable — unlike the 41-parameter
 * bloated strategies, these have a small enough parameter space that
 * systematic optimization can find real edge if it exists.
 */

import { getEma, getSma } from "./factors/moving-averages.js";
import { getRsi } from "./factors/mean-reversion.js";
import { getAtr } from "./factors/volatility.js";
import { getDonchianChannel } from "./factors/trend.js";
import { getMomentum } from "./factors/momentum.js";
import { getBollingerBands } from "./factors/oscillators.js";
import type { MarketStateConfig, ScoredStrategy, StrategyContext, SignalResult } from "./types.js";
import { buy, hold, sell } from "./scored-signal.js";

// ---------------------------------------------------------------------------
// 1. EMA Crossover Trend Following — 5 params
//    Buy when fast EMA crosses above slow EMA, sell when crosses below.
//    Simple, well-known, captures trends.
// ---------------------------------------------------------------------------

export function createEmaCrossoverStrategy(params?: {
  fastPeriod?: number;
  slowPeriod?: number;
  atrStopMult?: number;
  maxHoldBars?: number;
  minAtrPct?: number;
}): ScoredStrategy {
  const fastPeriod = params?.fastPeriod ?? 12;
  const slowPeriod = params?.slowPeriod ?? 26;
  const atrStopMult = params?.atrStopMult ?? 2.0;
  const maxHoldBars = params?.maxHoldBars ?? 72;
  const minAtrPct = params?.minAtrPct ?? 0.005;

  const parameters: Record<string, number> = {
    fastPeriod, slowPeriod, atrStopMult, maxHoldBars, minAtrPct
  };

  return {
    name: "ema-crossover",
    parameters,
    parameterCount: Object.keys(parameters).length,
    contextConfig: { trendWindow: slowPeriod + 10 },

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition } = context;
      const close = candles[index]?.closePrice;
      const fastEma = getEma(candles, index, fastPeriod);
      const slowEma = getEma(candles, index, slowPeriod);
      const prevFastEma = index > 0 ? getEma(candles, index - 1, fastPeriod) : null;
      const prevSlowEma = index > 0 ? getEma(candles, index - 1, slowPeriod) : null;
      const atr = getAtr(candles, index, 14);

      if (close === undefined || fastEma === null || slowEma === null || atr === null) {
        return hold("insufficient_data");
      }

      // Exit logic
      if (hasPosition && currentPosition) {
        const pnl = (close - currentPosition.entryPrice) / currentPosition.entryPrice;

        // Trailing stop via ATR
        if (pnl < -(atrStopMult * atr / close)) {
          return sell(0.9, "atr_stop");
        }

        // Max hold
        if (currentPosition.barsHeld >= maxHoldBars) {
          return sell(0.6, "max_hold");
        }

        // Death cross — fast EMA crosses below slow
        if (fastEma < slowEma && prevFastEma !== null && prevSlowEma !== null && prevFastEma >= prevSlowEma) {
          return sell(0.8, "death_cross");
        }

        return hold("hold_position");
      }

      // Entry logic — golden cross + minimum volatility
      if (prevFastEma !== null && prevSlowEma !== null) {
        const goldenCross = fastEma > slowEma && prevFastEma <= prevSlowEma;
        const hasVolatility = (atr / close) >= minAtrPct;

        if (goldenCross && hasVolatility) {
          return buy(0.7, "golden_cross");
        }
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 2. Donchian Breakout — 5 params
//    Buy when price breaks above N-bar high. Classic trend-following.
//    Used by the Turtle Traders.
// ---------------------------------------------------------------------------

export function createDonchianBreakoutStrategy(params?: {
  entryLookback?: number;
  exitLookback?: number;
  stopAtrMult?: number;
  maxHoldBars?: number;
  minChannelWidth?: number;
}): ScoredStrategy {
  const entryLookback = params?.entryLookback ?? 20;
  const exitLookback = params?.exitLookback ?? 10;
  const stopAtrMult = params?.stopAtrMult ?? 2.0;
  const maxHoldBars = params?.maxHoldBars ?? 96;
  const minChannelWidth = params?.minChannelWidth ?? 0.02;

  const parameters: Record<string, number> = {
    entryLookback, exitLookback, stopAtrMult, maxHoldBars, minChannelWidth
  };

  return {
    name: "donchian-breakout",
    parameters,
    parameterCount: Object.keys(parameters).length,
    contextConfig: { trendWindow: entryLookback + 5 },

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition } = context;
      const close = candles[index]?.closePrice;
      const high = candles[index]?.highPrice;
      const entryChannel = getDonchianChannel(candles, index, entryLookback);
      const exitChannel = getDonchianChannel(candles, index, exitLookback);
      const atr = getAtr(candles, index, 14);

      if (close === undefined || high === undefined || entryChannel === null || exitChannel === null || atr === null) {
        return hold("insufficient_data");
      }

      // Exit logic
      if (hasPosition && currentPosition) {
        const pnl = (close - currentPosition.entryPrice) / currentPosition.entryPrice;

        // ATR trailing stop
        if (pnl < -(stopAtrMult * atr / close)) {
          return sell(0.9, "atr_stop");
        }

        // Max hold
        if (currentPosition.barsHeld >= maxHoldBars) {
          return sell(0.6, "max_hold");
        }

        // Exit when price drops below shorter-period low
        if (close < exitChannel.lower) {
          return sell(0.8, "exit_channel_break");
        }

        return hold("hold_position");
      }

      // Entry: breakout above channel high with sufficient width
      const channelWidth = entryChannel.upper > 0
        ? (entryChannel.upper - entryChannel.lower) / entryChannel.upper
        : 0;

      if (high >= entryChannel.upper && channelWidth >= minChannelWidth) {
        return buy(0.7, "channel_breakout");
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 3. Simple RSI Mean Reversion — 5 params
//    Buy when RSI is oversold, sell when overbought. No filters, no gates.
//    Pure mean reversion on the simplest possible signal.
// ---------------------------------------------------------------------------

export function createSimpleRsiReversionStrategy(params?: {
  rsiPeriod?: number;
  oversold?: number;
  overbought?: number;
  stopLossPct?: number;
  maxHoldBars?: number;
}): ScoredStrategy {
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const oversold = params?.oversold ?? 30;
  const overbought = params?.overbought ?? 70;
  const stopLossPct = params?.stopLossPct ?? 0.05;
  const maxHoldBars = params?.maxHoldBars ?? 48;

  const parameters: Record<string, number> = {
    rsiPeriod, oversold, overbought, stopLossPct, maxHoldBars
  };

  return {
    name: "simple-rsi-reversion",
    parameters,
    parameterCount: Object.keys(parameters).length,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition } = context;
      const close = candles[index]?.closePrice;
      const rsi = getRsi(candles, index, rsiPeriod);

      if (close === undefined || rsi === null) {
        return hold("insufficient_data");
      }

      // Exit logic
      if (hasPosition && currentPosition) {
        const pnl = (close - currentPosition.entryPrice) / currentPosition.entryPrice;

        if (pnl < -stopLossPct) {
          return sell(0.9, "stop_loss");
        }

        if (currentPosition.barsHeld >= maxHoldBars) {
          return sell(0.6, "max_hold");
        }

        if (rsi >= overbought) {
          return sell(0.8, "rsi_overbought");
        }

        return hold("hold_position");
      }

      // Entry: RSI oversold
      if (rsi <= oversold) {
        return buy(0.7, "rsi_oversold");
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 4. Simple BB Mean Reversion — 6 params
//    Same idea as the 41-param version, but ONLY the core logic.
//    Buy below lower band + RSI oversold, sell at middle band or RSI mean.
// ---------------------------------------------------------------------------

export function createSimpleBbReversionStrategy(params?: {
  bbWindow?: number;
  bbMultiplier?: number;
  rsiPeriod?: number;
  entryRsi?: number;
  exitRsi?: number;
  stopLossPct?: number;
}): ScoredStrategy {
  const bbWindow = params?.bbWindow ?? 20;
  const bbMultiplier = params?.bbMultiplier ?? 2.0;
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const entryRsi = params?.entryRsi ?? 30;
  const exitRsi = params?.exitRsi ?? 50;
  const stopLossPct = params?.stopLossPct ?? 0.05;

  const parameters: Record<string, number> = {
    bbWindow, bbMultiplier, rsiPeriod, entryRsi, exitRsi, stopLossPct
  };

  return {
    name: "simple-bb-reversion",
    parameters,
    parameterCount: Object.keys(parameters).length,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition } = context;
      const close = candles[index]?.closePrice;
      const bb = getBollingerBands(candles, index, bbWindow, bbMultiplier);
      const rsi = getRsi(candles, index, rsiPeriod);

      if (close === undefined || bb === null || rsi === null) {
        return hold("insufficient_data");
      }

      // Exit: RSI mean-reverted or stop loss
      if (hasPosition && currentPosition) {
        const pnl = (close - currentPosition.entryPrice) / currentPosition.entryPrice;

        if (pnl < -stopLossPct) {
          return sell(0.9, "stop_loss");
        }

        if (rsi >= exitRsi) {
          return sell(0.8, "rsi_mean_reverted");
        }

        if (close >= bb.middle) {
          return sell(0.7, "bb_middle_reached");
        }

        return hold("hold_position");
      }

      // Entry: below lower band AND RSI oversold
      if (close <= bb.lower && rsi <= entryRsi) {
        return buy(0.7, "bb_oversold_rsi_confirmed");
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 5. Momentum Rotation — 5 params
//    Buy coins with strongest recent momentum. Pure cross-sectional.
//    Rebalance periodically. Uses marketState for relative strength.
// ---------------------------------------------------------------------------

export function createMomentumRotationStrategy(params?: {
  momentumLookback?: number;
  entryMomentumPct?: number;
  exitMomentumPct?: number;
  maxHoldBars?: number;
  stopLossPct?: number;
}): ScoredStrategy {
  const momentumLookback = params?.momentumLookback ?? 20;
  const entryMomentumPct = params?.entryMomentumPct ?? 0.03;
  const exitMomentumPct = params?.exitMomentumPct ?? -0.01;
  const maxHoldBars = params?.maxHoldBars ?? 48;
  const stopLossPct = params?.stopLossPct ?? 0.05;

  const parameters: Record<string, number> = {
    momentumLookback, entryMomentumPct, exitMomentumPct, maxHoldBars, stopLossPct
  };

  return {
    name: "momentum-rotation",
    parameters,
    parameterCount: Object.keys(parameters).length,
    contextConfig: { momentumLookback },

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition } = context;
      const close = candles[index]?.closePrice;
      const momentum = getMomentum(candles, index, momentumLookback);

      if (close === undefined || momentum === null) {
        return hold("insufficient_data");
      }

      const momentumPct = momentum / close;

      // Exit logic
      if (hasPosition && currentPosition) {
        const pnl = (close - currentPosition.entryPrice) / currentPosition.entryPrice;

        if (pnl < -stopLossPct) {
          return sell(0.9, "stop_loss");
        }

        if (currentPosition.barsHeld >= maxHoldBars) {
          return sell(0.6, "max_hold");
        }

        // Momentum reversed
        if (momentumPct < exitMomentumPct) {
          return sell(0.8, "momentum_reversed");
        }

        return hold("hold_position");
      }

      // Entry: strong positive momentum
      if (momentumPct > entryMomentumPct) {
        return buy(0.7, "strong_momentum");
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 6. Oversold Bounce Scalp — 6 params
//    Bear-market strategy: buy only on extreme oversold (RSI + BB),
//    take small profit quickly, cut losses fast. Short holding period.
// ---------------------------------------------------------------------------

export function createOversoldBounceScalpStrategy(params?: {
  rsiPeriod?: number;
  rsiEntry?: number;
  bbWindow?: number;
  bbMultiplier?: number;
  profitTargetPct?: number;
  stopLossPct?: number;
}): ScoredStrategy {
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const rsiEntry = params?.rsiEntry ?? 15;
  const bbWindow = params?.bbWindow ?? 20;
  const bbMultiplier = params?.bbMultiplier ?? 2.5;
  const profitTargetPct = params?.profitTargetPct ?? 0.02;
  const stopLossPct = params?.stopLossPct ?? 0.03;

  const parameters: Record<string, number> = {
    rsiPeriod, rsiEntry, bbWindow, bbMultiplier, profitTargetPct, stopLossPct
  };

  return {
    name: "oversold-bounce-scalp",
    parameters,
    parameterCount: Object.keys(parameters).length,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition } = context;
      const close = candles[index]?.closePrice;
      const rsi = getRsi(candles, index, rsiPeriod);
      const bb = getBollingerBands(candles, index, bbWindow, bbMultiplier);

      if (close === undefined || rsi === null || bb === null) {
        return hold("insufficient_data");
      }

      if (hasPosition && currentPosition) {
        const pnl = (close - currentPosition.entryPrice) / currentPosition.entryPrice;

        if (pnl >= profitTargetPct) {
          return sell(0.9, "profit_target");
        }

        if (pnl < -stopLossPct) {
          return sell(0.9, "stop_loss");
        }

        if (currentPosition.barsHeld >= 12) {
          return sell(0.7, "time_exit");
        }

        return hold("hold_position");
      }

      if (rsi <= rsiEntry && close < bb.lower) {
        return buy(0.8, "extreme_oversold_bounce");
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 7. Crash Dip Buy — 5 params
//    Buy after sharp single-bar drops, ride the dead cat bounce.
//    Uses ATR-normalized drop size to detect crashes.
// ---------------------------------------------------------------------------

export function createCrashDipBuyStrategy(params?: {
  atrPeriod?: number;
  dropAtrMult?: number;
  profitTargetPct?: number;
  stopLossPct?: number;
  maxHoldBars?: number;
}): ScoredStrategy {
  const atrPeriod = params?.atrPeriod ?? 14;
  const dropAtrMult = params?.dropAtrMult ?? 2.0;
  const profitTargetPct = params?.profitTargetPct ?? 0.015;
  const stopLossPct = params?.stopLossPct ?? 0.025;
  const maxHoldBars = params?.maxHoldBars ?? 8;

  const parameters: Record<string, number> = {
    atrPeriod, dropAtrMult, profitTargetPct, stopLossPct, maxHoldBars
  };

  return {
    name: "crash-dip-buy",
    parameters,
    parameterCount: Object.keys(parameters).length,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition } = context;
      const current = candles[index];
      const previous = candles[index - 1];
      const atr = getAtr(candles, index, atrPeriod);

      if (!current || !previous || atr === null || atr === 0) {
        return hold("insufficient_data");
      }

      const close = current.closePrice;

      if (hasPosition && currentPosition) {
        const pnl = (close - currentPosition.entryPrice) / currentPosition.entryPrice;

        if (pnl >= profitTargetPct) {
          return sell(0.9, "profit_target");
        }

        if (pnl < -stopLossPct) {
          return sell(0.9, "stop_loss");
        }

        if (currentPosition.barsHeld >= maxHoldBars) {
          return sell(0.7, "time_exit");
        }

        return hold("hold_position");
      }

      const barDrop = (previous.closePrice - close) / atr;
      if (barDrop >= dropAtrMult) {
        return buy(0.8, "crash_dip_detected");
      }

      return hold("no_signal");
    }
  };
}
