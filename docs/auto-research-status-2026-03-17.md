# Auto Research Status 2026-03-17

## Current State

- Auto-research run `overnight-2026-03-17-v3` completed.
- Output directory:
  - `/home/eugene/git/fst/research/backtester/artifacts/auto-research/overnight-2026-03-17-v3`
- Current process status:
  - no active auto-research process
- Final run status:
  - `completed`
  - `iteration 100 / 100`
  - finished at `2026-03-17T04:17:20.811Z`

Primary artifacts:

- `/home/eugene/git/fst/research/backtester/artifacts/auto-research/overnight-2026-03-17-v3/status.json`
- `/home/eugene/git/fst/research/backtester/artifacts/auto-research/overnight-2026-03-17-v3/run.log`
- `/home/eugene/git/fst/research/backtester/artifacts/auto-research/overnight-2026-03-17-v3/leaderboard.json`
- `/home/eugene/git/fst/research/backtester/artifacts/auto-research/overnight-2026-03-17-v3/report.json`
- `/home/eugene/git/fst/research/backtester/artifacts/auto-research/overnight-2026-03-17-v3/report.html`

## What Changed In Code

The research loop was upgraded from a narrow parameter search to a broader diagnostic search.

Implemented:

- Structured signal metadata:
  - strategy `BUY/SELL/HOLD` now carries `reason`, `tags`, and optional metrics
- Backtest diagnostics aggregation:
  - strategy reason counts
  - strategy tag counts
  - coordinator reject counts
  - execution reject counts
  - risk block counts
  - raw buy/sell/hold counts
  - universe size and coordinator coverage stats
- HTML report improvements:
  - per-candidate top reason display
  - best raw vs best with trades separation
- Stable strategy family expansion:
  - `relative-momentum-pullback`
  - `leader-pullback-state-machine`
  - `relative-breakout-rotation`
  - `momentum-reacceleration`
  - `leader-breakout-retest`
  - `compression-breakout-trend`
  - `leader-trend-continuation`

Key files touched:

- `/home/eugene/git/fst/research/strategies/src/types.ts`
- `/home/eugene/git/fst/research/strategies/src/scored-signal.ts`
- `/home/eugene/git/fst/research/strategies/src/relative-momentum-pullback.ts`
- `/home/eugene/git/fst/research/strategies/src/leader-pullback-state-machine.ts`
- `/home/eugene/git/fst/research/strategies/src/relative-breakout-rotation.ts`
- `/home/eugene/git/fst/research/strategies/src/momentum-reacceleration.ts`
- `/home/eugene/git/fst/research/strategies/src/leader-breakout-retest.ts`
- `/home/eugene/git/fst/research/strategies/src/compression-breakout-trend.ts`
- `/home/eugene/git/fst/research/strategies/src/leader-trend-continuation.ts`
- `/home/eugene/git/fst/research/backtester/src/backtest/BacktestEngine.ts`
- `/home/eugene/git/fst/research/backtester/src/portfolio/PortfolioCoordinator.ts`
- `/home/eugene/git/fst/research/backtester/src/auto-research/evaluate-worker.ts`
- `/home/eugene/git/fst/research/backtester/src/auto-research/prompt-builder.ts`
- `/home/eugene/git/fst/research/backtester/src/auto-research/report-html.ts`
- `/home/eugene/git/fst/research/backtester/src/strategy-registry.ts`

## Verification

Passed:

- `pnpm --filter @fst/backtester typecheck`
- `pnpm --filter @fst/backtester test`

Current test count:

- `36 passed`
- `0 failed`

## v3 Run Summary

Raw leaderboard counts:

- total evaluated rows in leaderboard: `205`
- positive rows: `201`

Important caveat:

- This is not `201` unique profitable strategies.
- Because later iterations reused strong candidates, the same family/parameter set appears many times.

Unique counts:

- unique evaluated family+parameter combinations: `10`
- unique positive family+parameter combinations: `6`
- unique positive candidate ids: `73`

Family distribution across evaluations:

- `momentum-reacceleration`: `102`
- `leader-pullback-state-machine`: `99`
- `relative-momentum-pullback`: `2`
- `relative-breakout-rotation`: `1`
- `leader-trend-continuation`: `1`

Positive family distribution:

- `momentum-reacceleration`: `102`
- `leader-pullback-state-machine`: `99`

Interpretation:

- The only families that actually survived this run were:
  - `leader-pullback-state-machine`
  - `momentum-reacceleration`
- Other families were effectively dead or zero-trade in this run.

## Best Candidates

Best overall candidate:

- candidate id: `lpsm_broader_expiry_02`
- family: `leader-pullback-state-machine`
- iteration first seen: `3`
- parameters:
  - `strengthFloor = 0.72`
  - `pullbackAtr = 0.7`
  - `setupExpiryBars = 6`
  - `trailAtrMult = 2.4`
- net return: `0.01639206119036721`
- max drawdown: `0.010244680402576797`
- trade count: `18`

Best trade candidate:

- same as best overall candidate

Other notable positive candidates:

1. `mr_shallow_reset_01`
   - family: `momentum-reacceleration`
   - params:
     - `strengthFloor = 0.72`
     - `minRiskOn = 0.12`
     - `resetRsiFloor = 52`
     - `trailAtrMult = 2`
   - net return: `0.01302337818009092`
   - trades: `12`

2. `mr_mid_reset_04`
   - family: `momentum-reacceleration`
   - net return: `0.012096114300491638`
   - trades: `14`

3. `lpsm_expiry_control_01`
   - family: `leader-pullback-state-machine`
   - net return: `0.010334178996114876`
   - trades: `12`

4. `mr_balanced_reset_02`
   - family: `momentum-reacceleration`
   - net return: `0.008941725007728324`
   - trades: `16`

## Diagnostic Snapshot

Best `leader-pullback-state-machine` reason profile from iteration 100:

- winner:
  - `lpsm_broader_expiry_workflow_fixed_03`
  - net: `+1.6392%`
  - trades: `18`
- dominant strategy reasons:
  - `market_regime_blocked`
  - `trend_regime_not_aligned`
  - `leader_strength_below_floor`
  - `pullback_state_not_armed`
- dominant successful tag pattern:
  - `leader`
  - `armed_pullback`
  - `reacceleration`

Best `momentum-reacceleration` reason profile from iteration 100:

- runner-up:
  - `mr_shallow_reset_workflow_fixed_03`
  - net: `+1.3023%`
  - trades: `12`
- dominant strategy reasons:
  - `trend_regime_not_aligned`
  - `leader_strength_below_floor`
  - `reset_reclaim_missing`
- dominant successful tag pattern:
  - `leader`
  - `reset`
  - `reclaim`

Interpretation:

- The current research engine is finding edge in:
  - leader pullback setups with broader setup expiry
  - shallow reset / reacceleration entries
- It is not finding edge in:
  - plain breakout rotation
  - the current strict relative momentum pullback baseline

## Known Problems

1. LLM review availability degraded late in the run.
   - iteration 99 and 100 ended with review fallback
   - the fallback reused the latest good candidates
   - this inflated repeated positive rows in the leaderboard

2. Search diversity is still not good enough.
   - only `10` unique family+parameter combos ended up being evaluated
   - the loop converged very quickly into two families

3. Results are holdout-only.
   - these are not yet walk-forward validated
   - no longer-period confirmation has been done after this run

4. Positive results are still modest.
   - best net return is about `+1.64%`
   - this is better than the previous run, but still not enough to treat as production-ready

## Recommended Next Step After Usage Reset

When usage resets, do this in order:

1. Freeze the two live families and validate them harder.
   - `leader-pullback-state-machine`
   - `momentum-reacceleration`

2. Run walk-forward only on the top family+parameter sets.
   - do not spend budget on dead families first

3. Add diversity pressure to proposal/review.
   - explicitly penalize repeated reuse of identical family+parameter sets
   - require at least one candidate outside the current winning family cluster

4. Reduce fallback repetition.
   - if LLM review fails repeatedly, stop cloning the same best candidates forever

5. If walk-forward still survives, then run a longer holdout and wider market coverage check.

## Suggested Restart Command

When ready to resume research:

```bash
pnpm --filter @fst/backtester dev -- --auto-research \
  --auto-research-iterations 50 \
  --auto-research-candidates 4 \
  --market-limit 10 \
  --limit 12000 \
  --holdout-days 180 \
  --llm-provider codex \
  --parallelism 4 \
  --auto-research-output /home/eugene/git/fst/research/backtester/artifacts/auto-research/next-run
```

## Short Conclusion

This run is the first one that produced nontrivial positive candidates after the research loop redesign.

Current practical conclusion:

- keep:
  - `leader-pullback-state-machine`
  - `momentum-reacceleration`
- demote:
  - `relative-momentum-pullback`
  - `relative-breakout-rotation`
  - any family that stays zero-trade without a clear diagnostic reason worth fixing

Do not treat the current best candidate as final.
Treat it as the first credible survivor worth revalidating.
