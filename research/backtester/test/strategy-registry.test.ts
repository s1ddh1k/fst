import test from "node:test";
import assert from "node:assert/strict";

import {
  createScoredStrategyByName,
  listScoredStrategyNames
} from "../src/strategy-registry.js";

test("scored strategy registry exposes every runtime strategy including residual reversion", () => {
  const names = listScoredStrategyNames();

  assert.ok(names.includes("residual-reversion"));

  for (const name of names) {
    const strategy = createScoredStrategyByName(name);
    assert.equal(strategy.name, name);
  }
});
