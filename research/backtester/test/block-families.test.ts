import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBlockFamilyDefinitions, getBlockFamilyById } from "../src/auto-research/block-families.js";

function isBbMeanReversionFamily(familyId: string): boolean {
  return familyId.includes("bb-reversion") || familyId.includes("bb-rsi-confirmed-reversion");
}

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
      if (isBbMeanReversionFamily(family.familyId)) continue;
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

  it("bb mean reversion families expose expanded entry and exit tuning parameters", () => {
    const bbFamilies = getBlockFamilyDefinitions().filter((family) => isBbMeanReversionFamily(family.familyId));
    assert.ok(bbFamilies.length >= 6);

    for (const family of bbFamilies) {
      const names = new Set(family.parameterSpecs.map((spec) => spec.name));
      assert.ok(names.has("entryRsiThreshold"), `${family.familyId} should expose entryRsiThreshold`);
      assert.ok(names.has("reclaimLookbackBars"), `${family.familyId} should expose reclaimLookbackBars`);
      assert.ok(names.has("reclaimPercentBThreshold"), `${family.familyId} should expose reclaimPercentBThreshold`);
      assert.ok(names.has("reclaimMinCloseBouncePct"), `${family.familyId} should expose reclaimMinCloseBouncePct`);
      assert.ok(names.has("reclaimBandWidthFactor"), `${family.familyId} should expose reclaimBandWidthFactor`);
      assert.ok(names.has("deepTouchEntryPercentB"), `${family.familyId} should expose deepTouchEntryPercentB`);
      assert.ok(names.has("deepTouchRsiThreshold"), `${family.familyId} should expose deepTouchRsiThreshold`);
      assert.ok(names.has("minBandWidth"), `${family.familyId} should expose minBandWidth`);
      assert.ok(names.has("trendUpExitRsiOffset"), `${family.familyId} should expose trendUpExitRsiOffset`);
      assert.ok(names.has("trendDownExitRsiOffset"), `${family.familyId} should expose trendDownExitRsiOffset`);
      assert.ok(names.has("rangeExitRsiOffset"), `${family.familyId} should expose rangeExitRsiOffset`);
      assert.ok(names.has("trendUpExitBandFraction"), `${family.familyId} should expose trendUpExitBandFraction`);
      assert.ok(names.has("trendDownExitBandFraction"), `${family.familyId} should expose trendDownExitBandFraction`);
      assert.ok(names.has("volatileExitBandFraction"), `${family.familyId} should expose volatileExitBandFraction`);
      assert.ok(names.has("profitTakePnlThreshold"), `${family.familyId} should expose profitTakePnlThreshold`);
      assert.ok(names.has("profitTakeBandWidthFactor"), `${family.familyId} should expose profitTakeBandWidthFactor`);
      assert.ok(names.has("trendDownProfitTargetScale"), `${family.familyId} should expose trendDownProfitTargetScale`);
      assert.ok(names.has("volatileProfitTargetScale"), `${family.familyId} should expose volatileProfitTargetScale`);
      assert.ok(names.has("cooldownBarsAfterLoss"), `${family.familyId} should expose cooldownBarsAfterLoss`);
      assert.ok(names.has("minBarsBetweenEntries"), `${family.familyId} should expose minBarsBetweenEntries`);
      assert.ok(names.has("profitTakeRsiFraction"), `${family.familyId} should expose profitTakeRsiFraction`);
      assert.ok(names.has("entryBenchmarkLeadWeight"), `${family.familyId} should expose entryBenchmarkLeadWeight`);
      assert.ok(names.has("entryBenchmarkLeadMinScore"), `${family.familyId} should expose entryBenchmarkLeadMinScore`);
      assert.ok(names.has("softExitScoreThreshold"), `${family.familyId} should expose softExitScoreThreshold`);
      assert.ok(names.has("softExitMinPnl"), `${family.familyId} should expose softExitMinPnl`);
      assert.ok(names.has("softExitMinBandFraction"), `${family.familyId} should expose softExitMinBandFraction`);
      assert.ok(names.has("exitVolumeFadeWeight"), `${family.familyId} should expose exitVolumeFadeWeight`);
      assert.ok(names.has("exitReversalWeight"), `${family.familyId} should expose exitReversalWeight`);
      assert.ok(names.has("exitMomentumDecayWeight"), `${family.familyId} should expose exitMomentumDecayWeight`);
      assert.ok(names.has("exitBenchmarkWeaknessWeight"), `${family.familyId} should expose exitBenchmarkWeaknessWeight`);
      assert.ok(names.has("exitRelativeFragilityWeight"), `${family.familyId} should expose exitRelativeFragilityWeight`);
      assert.ok(names.has("exitTimeDecayWeight"), `${family.familyId} should expose exitTimeDecayWeight`);
    }
  });

  it("bb mean reversion families use explicit touch vs rsi-confirmed naming", () => {
    const touchWeekly = getBlockFamilyById("block:bb-reversion-1h");
    const touchDaily = getBlockFamilyById("block:bb-reversion-1h-daily");
    const touchHourly = getBlockFamilyById("block:bb-reversion-1h-hourly");
    const confirmedWeekly = getBlockFamilyById("block:bb-rsi-confirmed-reversion-1h");
    const confirmedDaily = getBlockFamilyById("block:bb-rsi-confirmed-reversion-1h-daily");
    const confirmedHourly = getBlockFamilyById("block:bb-rsi-confirmed-reversion-1h-hourly");

    assert.match(touchWeekly.title, /Touch Mean Reversion/);
    assert.match(touchDaily.title, /Touch Mean Reversion/);
    assert.match(touchHourly.title, /Touch Mean Reversion/);
    assert.match(confirmedWeekly.title, /RSI-Confirmed Mean Reversion/);
    assert.match(confirmedDaily.title, /RSI-Confirmed Mean Reversion/);
    assert.match(confirmedHourly.title, /RSI-Confirmed Mean Reversion/);
  });
});
