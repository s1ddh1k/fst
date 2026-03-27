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
import { getVolumeSpikeRatio } from "./factors/volume.js";
import type { MarketStateConfig, ScoredStrategy, StrategyContext, SignalResult, MarketStateContext } from "./types.js";
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

// ---------------------------------------------------------------------------
// 8. Volume Breakout Trend Rider — 7 params
//    Bull-market strategy. Enter on breakout with volume confirmation,
//    ATR trailing stop lets winners run. No fixed profit target.
// ---------------------------------------------------------------------------

export function createVolumeBreakoutRiderStrategy(params?: {
  emaFast?: number;
  emaSlow?: number;
  volumeWindow?: number;
  volumeSpikeMult?: number;
  atrPeriod?: number;
  atrTrailMult?: number;
  maxHoldBars?: number;
}): ScoredStrategy {
  const emaFast = params?.emaFast ?? 10;
  const emaSlow = params?.emaSlow ?? 30;
  const volumeWindow = params?.volumeWindow ?? 20;
  const volumeSpikeMult = params?.volumeSpikeMult ?? 1.8;
  const atrPeriod = params?.atrPeriod ?? 14;
  const atrTrailMult = params?.atrTrailMult ?? 2.5;
  const maxHoldBars = params?.maxHoldBars ?? 72;

  const parameters: Record<string, number> = {
    emaFast, emaSlow, volumeWindow, volumeSpikeMult, atrPeriod, atrTrailMult, maxHoldBars
  };

  return {
    name: "volume-breakout-rider",
    parameters,
    parameterCount: Object.keys(parameters).length,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition } = context;
      const close = candles[index]?.closePrice;
      const fast = getEma(candles, index, emaFast);
      const slow = getEma(candles, index, emaSlow);
      const prevFast = index > 0 ? getEma(candles, index - 1, emaFast) : null;
      const prevSlow = index > 0 ? getEma(candles, index - 1, emaSlow) : null;
      const volSpike = getVolumeSpikeRatio(candles, index, volumeWindow);
      const atr = getAtr(candles, index, atrPeriod);

      if (close === undefined || fast === null || slow === null || atr === null || atr === 0 || volSpike === null) {
        return hold("insufficient_data");
      }

      // Exit: ATR trailing stop — let winners run
      if (hasPosition && currentPosition) {
        const highSinceEntry = Math.max(close, currentPosition.entryPrice);
        const trailStop = highSinceEntry - atrTrailMult * atr;

        if (close < trailStop) {
          return sell(0.9, "atr_trail_stop");
        }

        if (currentPosition.barsHeld >= maxHoldBars) {
          return sell(0.6, "max_hold");
        }

        // EMA death cross while in profit — take it
        if (fast < slow && (close - currentPosition.entryPrice) / currentPosition.entryPrice > 0.01) {
          return sell(0.7, "ema_cross_exit");
        }

        return hold("hold_position");
      }

      // Entry: EMA golden cross + volume spike (trend start with conviction)
      if (prevFast !== null && prevSlow !== null &&
          fast > slow && prevFast <= prevSlow &&
          volSpike >= volumeSpikeMult) {
        return buy(0.85, "volume_confirmed_breakout");
      }

      // Entry: price above both EMAs + volume spike (trend continuation)
      if (fast > slow && close > fast &&
          volSpike >= volumeSpikeMult &&
          (close - fast) / close < 0.02) { // not too extended
        return buy(0.7, "trend_continuation_volume");
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 9. Volume Exhaustion Bounce — 7 params
//    Bear-market strategy. Detects panic selling via volume spike + sharp drop
//    over multiple bars. More reliable than single-bar crash detection.
// ---------------------------------------------------------------------------

export function createVolumeExhaustionBounceStrategy(params?: {
  dropLookback?: number;
  dropThresholdPct?: number;
  volumeWindow?: number;
  volumeSpikeMult?: number;
  rsiPeriod?: number;
  rsiEntry?: number;
  profitTargetPct?: number;
}): ScoredStrategy {
  const dropLookback = params?.dropLookback ?? 5;
  const dropThresholdPct = params?.dropThresholdPct ?? 0.06;
  const volumeWindow = params?.volumeWindow ?? 20;
  const volumeSpikeMult = params?.volumeSpikeMult ?? 2.5;
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const rsiEntry = params?.rsiEntry ?? 20;
  const profitTargetPct = params?.profitTargetPct ?? 0.025;

  const parameters: Record<string, number> = {
    dropLookback, dropThresholdPct, volumeWindow, volumeSpikeMult, rsiPeriod, rsiEntry, profitTargetPct
  };

  return {
    name: "volume-exhaustion-bounce",
    parameters,
    parameterCount: Object.keys(parameters).length,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition } = context;
      if (index < dropLookback) return hold("insufficient_data");

      const close = candles[index]?.closePrice;
      const pastClose = candles[index - dropLookback]?.closePrice;
      const rsi = getRsi(candles, index, rsiPeriod);
      const volSpike = getVolumeSpikeRatio(candles, index, volumeWindow);

      if (close === undefined || pastClose === undefined || rsi === null || volSpike === null || pastClose === 0) {
        return hold("insufficient_data");
      }

      const dropPct = (pastClose - close) / pastClose;

      // Exit: profit target or time-based
      if (hasPosition && currentPosition) {
        const pnl = (close - currentPosition.entryPrice) / currentPosition.entryPrice;

        if (pnl >= profitTargetPct) {
          return sell(0.9, "profit_target");
        }

        // Adaptive stop: half of profit target
        if (pnl < -(profitTargetPct * 1.5)) {
          return sell(0.9, "stop_loss");
        }

        if (currentPosition.barsHeld >= 18) {
          return sell(0.6, "time_exit");
        }

        // RSI recovered — take what we have
        if (rsi > 50 && pnl > 0) {
          return sell(0.7, "rsi_recovered");
        }

        return hold("hold_position");
      }

      // Entry: multi-bar drop + volume spike + RSI oversold = capitulation exhaustion
      if (dropPct >= dropThresholdPct &&
          volSpike >= volumeSpikeMult &&
          rsi <= rsiEntry) {
        return buy(0.85, "volume_exhaustion_detected");
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 10. BB Squeeze Scalp — 6 params
//    Sideways strategy. Trade only when Bollinger Bands are contracted (squeeze).
//    Buy at lower band, sell at upper band. Inactive during trending markets.
// ---------------------------------------------------------------------------

export function createBbSqueezeScalpStrategy(params?: {
  bbWindow?: number;
  bbMultiplier?: number;
  squeezeMaxWidth?: number;
  rsiPeriod?: number;
  rsiOversold?: number;
  rsiOverbought?: number;
}): ScoredStrategy {
  const bbWindow = params?.bbWindow ?? 20;
  const bbMultiplier = params?.bbMultiplier ?? 2.0;
  const squeezeMaxWidth = params?.squeezeMaxWidth ?? 0.04;
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const rsiOversold = params?.rsiOversold ?? 30;
  const rsiOverbought = params?.rsiOverbought ?? 70;

  const parameters: Record<string, number> = {
    bbWindow, bbMultiplier, squeezeMaxWidth, rsiPeriod, rsiOversold, rsiOverbought
  };

  return {
    name: "bb-squeeze-scalp",
    parameters,
    parameterCount: Object.keys(parameters).length,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition } = context;
      const close = candles[index]?.closePrice;
      const bb = getBollingerBands(candles, index, bbWindow, bbMultiplier);
      const rsi = getRsi(candles, index, rsiPeriod);

      if (close === undefined || bb === null || rsi === null || bb.upper === 0) {
        return hold("insufficient_data");
      }

      const bbWidth = (bb.upper - bb.lower) / bb.middle;

      // Exit
      if (hasPosition && currentPosition) {
        const pnl = (close - currentPosition.entryPrice) / currentPosition.entryPrice;

        // Dynamic exit: sell at upper band or RSI overbought
        if (close >= bb.upper || rsi >= rsiOverbought) {
          return sell(0.8, "bb_upper_or_rsi_exit");
        }

        // Stop at middle band breakdown if losing
        if (pnl < 0 && close < bb.middle && rsi < 45) {
          return sell(0.7, "bb_middle_breakdown");
        }

        // Hard stop
        if (pnl < -0.04) {
          return sell(0.9, "hard_stop");
        }

        if (currentPosition.barsHeld >= 36) {
          return sell(0.6, "max_hold");
        }

        return hold("hold_position");
      }

      // Entry: only during BB squeeze (low volatility) + price at lower band + RSI oversold
      if (bbWidth <= squeezeMaxWidth &&
          close <= bb.lower &&
          rsi <= rsiOversold) {
        return buy(0.8, "bb_squeeze_oversold");
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 11. Relative Strength Volume Bounce — 7 params
//    All-regime strategy. Combines relative strength (this coin is stronger
//    than average) with volume exhaustion entry and ATR trailing exit.
//    Key insight: even in bear markets, relatively strong coins bounce harder.
// ---------------------------------------------------------------------------

export function createRelativeStrengthBounceStrategy(params?: {
  minMomentumPercentile?: number;
  rsiPeriod?: number;
  rsiEntry?: number;
  volumeWindow?: number;
  volumeSpikeMult?: number;
  atrPeriod?: number;
  atrTrailMult?: number;
}): ScoredStrategy {
  const minMomentumPercentile = params?.minMomentumPercentile ?? 0.6;
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const rsiEntry = params?.rsiEntry ?? 30;
  const volumeWindow = params?.volumeWindow ?? 20;
  const volumeSpikeMult = params?.volumeSpikeMult ?? 1.5;
  const atrPeriod = params?.atrPeriod ?? 14;
  const atrTrailMult = params?.atrTrailMult ?? 2.0;

  const parameters: Record<string, number> = {
    minMomentumPercentile, rsiPeriod, rsiEntry, volumeWindow, volumeSpikeMult, atrPeriod, atrTrailMult
  };

  return {
    name: "relative-strength-bounce",
    parameters,
    parameterCount: Object.keys(parameters).length,
    contextConfig: { trendWindow: 55 },

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition, marketState } = context;
      const close = candles[index]?.closePrice;
      const rsi = getRsi(candles, index, rsiPeriod);
      const volSpike = getVolumeSpikeRatio(candles, index, volumeWindow);
      const atr = getAtr(candles, index, atrPeriod);
      const rs = marketState?.relativeStrength;

      if (close === undefined || rsi === null || volSpike === null || atr === null || atr === 0) {
        return hold("insufficient_data");
      }

      // Exit: ATR trailing stop
      if (hasPosition && currentPosition) {
        const highSinceEntry = Math.max(close, currentPosition.entryPrice);
        const trailStop = highSinceEntry - atrTrailMult * atr;

        if (close < trailStop) {
          return sell(0.9, "atr_trail_stop");
        }

        if (currentPosition.barsHeld >= 48) {
          return sell(0.6, "max_hold");
        }

        return hold("hold_position");
      }

      // Entry: relative strength filter + RSI oversold + volume spike
      const percentile = rs?.momentumPercentile ?? 0.5;
      if (percentile >= minMomentumPercentile &&
          rsi <= rsiEntry &&
          volSpike >= volumeSpikeMult) {
        return buy(0.85, "strong_coin_oversold_volume");
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 12. Trend Acceleration Rider — 7 params
//    Bull-market strategy. Enters when a strong coin accelerates (momentum
//    increasing, not just positive). Uses relative strength to pick winners.
//    ATR trailing stop for exits.
// ---------------------------------------------------------------------------

export function createTrendAccelerationStrategy(params?: {
  minMomentumPercentile?: number;
  momentumLookback?: number;
  accelerationLookback?: number;
  volumeWindow?: number;
  volumeMinMult?: number;
  atrPeriod?: number;
  atrTrailMult?: number;
}): ScoredStrategy {
  const minMomentumPercentile = params?.minMomentumPercentile ?? 0.7;
  const momentumLookback = params?.momentumLookback ?? 12;
  const accelerationLookback = params?.accelerationLookback ?? 6;
  const volumeWindow = params?.volumeWindow ?? 20;
  const volumeMinMult = params?.volumeMinMult ?? 1.2;
  const atrPeriod = params?.atrPeriod ?? 14;
  const atrTrailMult = params?.atrTrailMult ?? 2.5;

  const parameters: Record<string, number> = {
    minMomentumPercentile, momentumLookback, accelerationLookback, volumeWindow, volumeMinMult, atrPeriod, atrTrailMult
  };

  return {
    name: "trend-acceleration",
    parameters,
    parameterCount: Object.keys(parameters).length,
    contextConfig: { momentumLookback },

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition, marketState } = context;
      const close = candles[index]?.closePrice;
      const mom = getMomentum(candles, index, momentumLookback);
      const prevMom = index >= accelerationLookback ? getMomentum(candles, index - accelerationLookback, momentumLookback) : null;
      const volSpike = getVolumeSpikeRatio(candles, index, volumeWindow);
      const atr = getAtr(candles, index, atrPeriod);
      const rs = marketState?.relativeStrength;

      if (close === undefined || mom === null || prevMom === null || atr === null || atr === 0 || volSpike === null) {
        return hold("insufficient_data");
      }

      const momPct = mom / close;
      const prevMomPct = prevMom / (candles[index - accelerationLookback]?.closePrice || close);

      // Exit: ATR trailing stop
      if (hasPosition && currentPosition) {
        const highSinceEntry = Math.max(close, currentPosition.entryPrice);
        const trailStop = highSinceEntry - atrTrailMult * atr;

        if (close < trailStop) {
          return sell(0.9, "atr_trail_stop");
        }

        // Momentum deceleration while profitable — partial exit signal
        if (momPct < prevMomPct * 0.5 && (close - currentPosition.entryPrice) / currentPosition.entryPrice > 0.02) {
          return sell(0.7, "momentum_deceleration");
        }

        if (currentPosition.barsHeld >= 96) {
          return sell(0.6, "max_hold");
        }

        return hold("hold_position");
      }

      // Entry: strong coin + momentum accelerating + above-average volume
      const percentile = rs?.momentumPercentile ?? 0.5;
      if (percentile >= minMomentumPercentile &&
          momPct > 0 &&
          momPct > prevMomPct && // acceleration
          volSpike >= volumeMinMult) {
        return buy(0.85, "trend_acceleration_strong_coin");
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 5m STRATEGIES — higher frequency, more trades, smaller moves
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 13. Volume Exhaustion Bounce 5m — 7 params
//    Same concept as 1h version but on 5m: catch micro-capitulation events.
//    12x more opportunities per day. Tighter stops, faster exits.
// ---------------------------------------------------------------------------

export function createVolumeExhaustionBounce5mStrategy(params?: {
  dropLookback?: number;
  dropThresholdPct?: number;
  volumeWindow?: number;
  volumeSpikeMult?: number;
  rsiPeriod?: number;
  rsiEntry?: number;
  profitTargetPct?: number;
}): ScoredStrategy {
  const dropLookback = params?.dropLookback ?? 6;
  const dropThresholdPct = params?.dropThresholdPct ?? 0.02;
  const volumeWindow = params?.volumeWindow ?? 24;
  const volumeSpikeMult = params?.volumeSpikeMult ?? 2.0;
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const rsiEntry = params?.rsiEntry ?? 25;
  const profitTargetPct = params?.profitTargetPct ?? 0.008;

  const parameters: Record<string, number> = {
    dropLookback, dropThresholdPct, volumeWindow, volumeSpikeMult, rsiPeriod, rsiEntry, profitTargetPct
  };

  return {
    name: "volume-exhaustion-5m",
    parameters,
    parameterCount: Object.keys(parameters).length,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition } = context;
      if (index < dropLookback) return hold("insufficient_data");

      const close = candles[index]?.closePrice;
      const pastClose = candles[index - dropLookback]?.closePrice;
      const rsi = getRsi(candles, index, rsiPeriod);
      const volSpike = getVolumeSpikeRatio(candles, index, volumeWindow);

      if (close === undefined || pastClose === undefined || rsi === null || volSpike === null || pastClose === 0) {
        return hold("insufficient_data");
      }

      const dropPct = (pastClose - close) / pastClose;

      if (hasPosition && currentPosition) {
        const pnl = (close - currentPosition.entryPrice) / currentPosition.entryPrice;

        if (pnl >= profitTargetPct) {
          return sell(0.9, "profit_target");
        }

        if (pnl < -(profitTargetPct * 2)) {
          return sell(0.9, "stop_loss");
        }

        // 5m: max 36 bars = 3 hours
        if (currentPosition.barsHeld >= 36) {
          return sell(0.6, "time_exit");
        }

        if (rsi > 50 && pnl > 0) {
          return sell(0.7, "rsi_recovered");
        }

        return hold("hold_position");
      }

      if (dropPct >= dropThresholdPct &&
          volSpike >= volumeSpikeMult &&
          rsi <= rsiEntry) {
        return buy(0.85, "5m_volume_exhaustion");
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 14. Oversold Scalp 5m — 6 params
//    5m version of oversold bounce. More signals, tighter targets.
// ---------------------------------------------------------------------------

export function createOversoldScalp5mStrategy(params?: {
  rsiPeriod?: number;
  rsiEntry?: number;
  bbWindow?: number;
  bbMultiplier?: number;
  profitTargetPct?: number;
  stopLossPct?: number;
}): ScoredStrategy {
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const rsiEntry = params?.rsiEntry ?? 20;
  const bbWindow = params?.bbWindow ?? 20;
  const bbMultiplier = params?.bbMultiplier ?? 2.0;
  const profitTargetPct = params?.profitTargetPct ?? 0.006;
  const stopLossPct = params?.stopLossPct ?? 0.01;

  const parameters: Record<string, number> = {
    rsiPeriod, rsiEntry, bbWindow, bbMultiplier, profitTargetPct, stopLossPct
  };

  return {
    name: "oversold-scalp-5m",
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

        // 5m: max 24 bars = 2 hours
        if (currentPosition.barsHeld >= 24) {
          return sell(0.7, "time_exit");
        }

        return hold("hold_position");
      }

      if (rsi <= rsiEntry && close < bb.lower) {
        return buy(0.8, "5m_oversold_bounce");
      }

      return hold("no_signal");
    }
  };
}

// ---------------------------------------------------------------------------
// 15. Momentum Burst 5m — 6 params
//    Catch short-term momentum bursts on 5m. Volume-confirmed breakouts
//    with ATR trailing stop. Works in all regimes — momentum bursts happen
//    even in bear markets (relief rallies).
// ---------------------------------------------------------------------------

export function createMomentumBurst5mStrategy(params?: {
  momentumLookback?: number;
  momentumThresholdPct?: number;
  volumeWindow?: number;
  volumeSpikeMult?: number;
  atrPeriod?: number;
  atrTrailMult?: number;
}): ScoredStrategy {
  const momentumLookback = params?.momentumLookback ?? 12;
  const momentumThresholdPct = params?.momentumThresholdPct ?? 0.015;
  const volumeWindow = params?.volumeWindow ?? 24;
  const volumeSpikeMult = params?.volumeSpikeMult ?? 1.8;
  const atrPeriod = params?.atrPeriod ?? 14;
  const atrTrailMult = params?.atrTrailMult ?? 2.0;

  const parameters: Record<string, number> = {
    momentumLookback, momentumThresholdPct, volumeWindow, volumeSpikeMult, atrPeriod, atrTrailMult
  };

  return {
    name: "momentum-burst-5m",
    parameters,
    parameterCount: Object.keys(parameters).length,
    contextConfig: { momentumLookback },

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition } = context;
      const close = candles[index]?.closePrice;
      const mom = getMomentum(candles, index, momentumLookback);
      const volSpike = getVolumeSpikeRatio(candles, index, volumeWindow);
      const atr = getAtr(candles, index, atrPeriod);

      if (close === undefined || mom === null || volSpike === null || atr === null || atr === 0) {
        return hold("insufficient_data");
      }

      const momPct = mom / close;

      if (hasPosition && currentPosition) {
        const highSinceEntry = Math.max(close, currentPosition.entryPrice);
        const trailStop = highSinceEntry - atrTrailMult * atr;

        if (close < trailStop) {
          return sell(0.9, "atr_trail_stop");
        }

        // 5m: max 48 bars = 4 hours
        if (currentPosition.barsHeld >= 48) {
          return sell(0.6, "max_hold");
        }

        return hold("hold_position");
      }

      // Entry: strong momentum burst + volume confirmation
      if (momPct >= momentumThresholdPct && volSpike >= volumeSpikeMult) {
        return buy(0.85, "5m_momentum_burst");
      }

      return hold("no_signal");
    }
  };
}
