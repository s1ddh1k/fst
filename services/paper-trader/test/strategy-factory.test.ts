import test from "node:test";
import assert from "node:assert/strict";

import {
  createScoredStrategyFromRecommendation,
  isScoredStrategy
} from "../src/strategy-factory.js";

test("paper trader supports every scored strategy the research pipeline can promote", () => {
  const supportedStrategies = [
    "relative-momentum-pullback",
    "leader-pullback-state-machine",
    "relative-breakout-rotation",
    "momentum-reacceleration",
    "leader-breakout-retest",
    "compression-breakout-trend",
    "leader-trend-continuation",
    "residual-reversion"
  ] as const;

  for (const strategyName of supportedStrategies) {
    assert.equal(isScoredStrategy(strategyName), true);

    const strategy = createScoredStrategyFromRecommendation({
      strategyName,
      parametersJson: {}
    });

    assert.equal(strategy.name, strategyName);
  }
});
