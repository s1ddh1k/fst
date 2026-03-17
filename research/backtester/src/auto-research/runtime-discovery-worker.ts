import { listScoredStrategyNames } from "../strategy-registry.js";

console.log(
  JSON.stringify(
    {
      scoredStrategyNames: listScoredStrategyNames()
    },
    null,
    2
  )
);
