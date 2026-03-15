# Strategy Follow-up Report

Generated: 2026-03-15T15:10:35.637Z

## Config

- timeframe: `1h`
- universe: `krw-top`
- marketLimit: 10
- candidatePoolSize: 82
- trainingDays: 90
- holdoutDays: 30
- stepDays: 14
- minCandles: 3538

## Entry Vs Exit Conclusion

Baseline verdict: **entry**

Ghost BUY signals themselves are sparse or remain net-negative after cost across forward horizons, so the baseline failure is primarily an entry-quality and entry-frequency problem.

## Recommendation

Production candidate: **none**

No strategy cleared sufficiency, performance, and robustness together. The correct production decision is to reject all candidates for now.

## Best By Strategy

| Strategy | Params | Avg Test | Median Test | Exec Trades | Signals | Ghost | Boot | Rand | Eligible |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| relative-momentum-pullback | `{"minStrengthPct":0.7,"minRiskOn":0.05,"pullbackZ":0.9,"trailAtrMult":1.8}` | -0.13% | 0.00% | 1 | 1 | 1 | 0.00% | 0.00% | no |

## Top Overall

| Strategy | Params | Avg Test | Median Test | Exec Trades | Signals | Ghost | Boot | Rand | Eligible |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| relative-momentum-pullback | `{"minStrengthPct":0.7,"minRiskOn":0.05,"pullbackZ":0.9,"trailAtrMult":1.8}` | -0.13% | 0.00% | 1 | 1 | 1 | 0.00% | 0.00% | no |
| relative-momentum-pullback | `{"minStrengthPct":0.7,"minRiskOn":0.05,"pullbackZ":0.9,"trailAtrMult":2.2}` | -0.13% | 0.00% | 1 | 1 | 1 | 0.00% | 0.00% | no |
| relative-momentum-pullback | `{"minStrengthPct":0.7,"minRiskOn":0.05,"pullbackZ":0.9,"trailAtrMult":2.6}` | -0.13% | 0.00% | 1 | 1 | 1 | 0.00% | 0.00% | no |
| relative-momentum-pullback | `{"minStrengthPct":0.7,"minRiskOn":0.05,"pullbackZ":1.2,"trailAtrMult":1.8}` | -0.13% | 0.00% | 1 | 1 | 1 | 0.00% | 0.00% | no |
| relative-momentum-pullback | `{"minStrengthPct":0.7,"minRiskOn":0.05,"pullbackZ":1.2,"trailAtrMult":2.2}` | -0.13% | 0.00% | 1 | 1 | 1 | 0.00% | 0.00% | no |
| relative-momentum-pullback | `{"minStrengthPct":0.7,"minRiskOn":0.05,"pullbackZ":1.2,"trailAtrMult":2.6}` | -0.13% | 0.00% | 1 | 1 | 1 | 0.00% | 0.00% | no |
| relative-momentum-pullback | `{"minStrengthPct":0.7,"minRiskOn":0.15,"pullbackZ":0.9,"trailAtrMult":1.8}` | -0.13% | 0.00% | 1 | 1 | 1 | 0.00% | 0.00% | no |
| relative-momentum-pullback | `{"minStrengthPct":0.7,"minRiskOn":0.15,"pullbackZ":0.9,"trailAtrMult":2.2}` | -0.13% | 0.00% | 1 | 1 | 1 | 0.00% | 0.00% | no |
| relative-momentum-pullback | `{"minStrengthPct":0.7,"minRiskOn":0.15,"pullbackZ":0.9,"trailAtrMult":2.6}` | -0.13% | 0.00% | 1 | 1 | 1 | 0.00% | 0.00% | no |
| relative-momentum-pullback | `{"minStrengthPct":0.7,"minRiskOn":0.15,"pullbackZ":1.2,"trailAtrMult":1.8}` | -0.13% | 0.00% | 1 | 1 | 1 | 0.00% | 0.00% | no |

## Notes

- `executedTradeCount` counts completed OOS trades (filled exits / round trips) in the walk-forward windows.
- `signalCount` counts coordinator-selected BUY intents in OOS windows.
- `ghostSignalCount` counts raw BUY candidates before execution constraints, studied with next-bar-open references.
- `bootstrapPassRate` and `randomPassRate` are fold-level pass ratios across the walk-forward windows.