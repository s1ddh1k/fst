/**
 * Verify paper trading setup: load recommendations and instantiate strategies.
 * Run: npx tsx src/verify-setup.ts
 */

import { getRecommendations } from "./service.js";
import { createScoredStrategyFromRecommendation, isScoredStrategy } from "./strategy-factory.js";

async function main() {
  const recommendations = await getRecommendations({ limit: 10 });

  if (recommendations.length === 0) {
    console.error("No active recommendations found.");
    process.exit(1);
  }

  console.log(`Found ${recommendations.length} active recommendations:\n`);

  for (const rec of recommendations) {
    const names = rec.strategyNames;
    const params = rec.parametersJson;
    const market = (params as Record<string, unknown>)?.marketCode ?? "unknown";

    console.log(`Rank ${rec.rank}: ${names.join(", ")} on ${market}`);
    console.log(`  Test return: ${(rec.avgTestReturn * 100).toFixed(1)}%, Drawdown: ${(rec.avgTestDrawdown * 100).toFixed(1)}%`);

    for (const name of names) {
      if (isScoredStrategy(name)) {
        try {
          const strategy = createScoredStrategyFromRecommendation({ strategyName: name, parametersJson: params });
          console.log(`  ✓ Strategy "${strategy.name}" loaded OK (${strategy.parameterCount} params)`);
        } catch (e) {
          console.error(`  ✗ Failed to load "${name}":`, (e as Error).message);
        }
      } else {
        console.log(`  ? "${name}" is not a scored strategy`);
      }
    }
    console.log();
  }

  console.log("Setup verified. Ready for: pnpm dev");
}

main().catch(console.error);
