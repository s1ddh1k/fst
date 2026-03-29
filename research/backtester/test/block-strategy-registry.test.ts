import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBlockFamilyDefinitions } from "../src/auto-research/block-families.js";

describe("block-families strategy integration", () => {
  const allFamilies = getBlockFamilyDefinitions();
  const simpleFamilies = allFamilies.filter((f) => f.familyId.startsWith("block:simple-"));

  it("every simple family has create + sleeveId + family on the definition", () => {
    const missing: string[] = [];
    for (const family of simpleFamilies) {
      if (!family.create && !family.createStrategy) {
        missing.push(`${family.familyId}: no create or createStrategy`);
      }
      if (!family.sleeveId) {
        missing.push(`${family.familyId}: no sleeveId`);
      }
    }
    assert.deepEqual(missing, [], `Missing fields:\n${missing.join("\n")}`);
  });

  it("every simple family has createStrategy attached", async () => {
    const failures: string[] = [];
    for (const family of simpleFamilies) {
      if (!family.createStrategy) {
        failures.push(`${family.familyId}: no createStrategy`);
        continue;
      }
      try {
        const strategy = await family.createStrategy("test", {});
        if (!strategy) failures.push(`${family.familyId}: createStrategy returned null`);
      } catch (error) {
        failures.push(`${family.familyId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    assert.deepEqual(failures, [], `createStrategy failures:\n${failures.join("\n")}`);
  });

  it("every simple family creates a Strategy with matching timeframe", async () => {
    const mismatches: string[] = [];
    for (const family of simpleFamilies) {
      if (!family.createStrategy) continue;
      try {
        const strategy = await family.createStrategy("test", {});
        if (strategy.decisionTimeframe !== family.timeframe) {
          mismatches.push(
            `${family.familyId}: family.timeframe=${family.timeframe}, strategy.decisionTimeframe=${strategy.decisionTimeframe}`
          );
        }
      } catch { /* skip creation errors — tested elsewhere */ }
    }
    assert.deepEqual(mismatches, [], `Timeframe mismatches:\n${mismatches.join("\n")}`);
  });

  it("no duplicate familyIds", () => {
    const ids = allFamilies.map((f) => f.familyId);
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    assert.deepEqual(duplicates, [], `Duplicate familyIds: ${duplicates.join(", ")}`);
  });

  it("familyId naming convention: timeframe suffix matches definition timeframe", () => {
    const mismatches: string[] = [];
    for (const family of allFamilies) {
      const id = family.familyId;
      if (id.includes("-15m") && family.timeframe !== "15m") {
        mismatches.push(`${id} has -15m suffix but timeframe=${family.timeframe}`);
      }
      if (id.includes("-5m") && family.timeframe !== "5m") {
        mismatches.push(`${id} has -5m suffix but timeframe=${family.timeframe}`);
      }
      if (id.includes("-1h") && family.timeframe !== "1h") {
        mismatches.push(`${id} has -1h suffix but timeframe=${family.timeframe}`);
      }
    }
    assert.deepEqual(mismatches, [], `Naming mismatches:\n${mismatches.join("\n")}`);
  });

  it("requiredData includes the decision timeframe", () => {
    const mismatches: string[] = [];
    for (const family of allFamilies) {
      const required = family.requiredData ?? [family.timeframe];
      if (!required.includes(family.timeframe)) {
        mismatches.push(`${family.familyId}: timeframe=${family.timeframe} not in requiredData`);
      }
    }
    assert.deepEqual(mismatches, [], `Missing timeframe in requiredData:\n${mismatches.join("\n")}`);
  });

  it("create function produces a valid ScoredStrategy with default params", () => {
    const failures: string[] = [];
    for (const family of simpleFamilies) {
      if (!family.create) continue;
      try {
        const strategy = family.create({});
        if (!strategy.name) failures.push(`${family.familyId}: no name`);
        if (typeof strategy.generateSignal !== "function") failures.push(`${family.familyId}: no generateSignal`);
      } catch (error) {
        failures.push(`${family.familyId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    assert.deepEqual(failures, [], `create() failures:\n${failures.join("\n")}`);
  });
});
