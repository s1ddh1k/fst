import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBlockFamilyDefinitions, getBlockFamilyById } from "../src/auto-research/block-families.js";

describe("block-families", () => {
  it("returns all block family definitions", () => {
    const families = getBlockFamilyDefinitions();
    assert.ok(families.length >= 4, `Expected at least 4 block families, got ${families.length}`);
    for (const family of families) {
      assert.ok(family.familyId.startsWith("block:"), `Family ${family.familyId} should start with 'block:'`);
      assert.ok(family.strategyName.startsWith("block:"), `Strategy name should start with 'block:'`);
      assert.ok(family.parameterSpecs.length >= 4, `Family ${family.familyId} should have at least 4 params`);
      assert.ok(family.timeframe, `Family ${family.familyId} should have a timeframe`);
    }
  });

  it("retrieves a block family by id", () => {
    const family = getBlockFamilyById("block:rotation-15m-trend-up");
    assert.equal(family.familyId, "block:rotation-15m-trend-up");
    assert.equal(family.timeframe, "15m");
    assert.ok(family.requiredData?.includes("15m"));
    assert.ok(family.requiredData?.includes("5m"));
  });

  it("throws on unknown block family", () => {
    assert.throws(
      () => getBlockFamilyById("nonexistent"),
      /Unknown block family/
    );
  });

  it("each non-bb block family has gate parameters", () => {
    const families = getBlockFamilyDefinitions();
    for (const family of families) {
      // BB mean reversion families operate without regime gates
      if (family.familyId.includes("bb-reversion")) continue;
      const gateParams = family.parameterSpecs.filter((p) => p.name.startsWith("gate"));
      assert.ok(gateParams.length >= 2, `Family ${family.familyId} should have at least 2 gate params, got ${gateParams.length}`);
    }
  });

  it("parameter specs have valid min/max ranges", () => {
    const families = getBlockFamilyDefinitions();
    for (const family of families) {
      for (const spec of family.parameterSpecs) {
        assert.ok(spec.min < spec.max, `${family.familyId}.${spec.name}: min ${spec.min} should be < max ${spec.max}`);
      }
    }
  });
});
