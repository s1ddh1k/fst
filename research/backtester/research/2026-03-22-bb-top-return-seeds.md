# BB High-Return Seed Notes (2026-03-22)

## 목적

볼린저 밴드 계열에서 수익률이 높게 나온 후보를 다시 seed로 쓰기 쉽게 정리했다.

- 사람용 요약 문서: `/home/siddhik/git/fst/research/backtester/research/2026-03-22-bb-top-return-seeds.md`
- 재실행용 seed catalog: `/home/siddhik/git/fst/research/backtester/research/2026-03-22-bb-top-return-seeds.json`

위 JSON은 `--auto-research-seed-artifact`에 바로 넣을 수 있다.

## 최고 수익 스냅샷

- 전체 저장 아티팩트 기준 최고 수익: `bb-weekly-cached-16-wf`, `+10.47%`, `MDD 6.25%`, `37.7 trades`
  - source: `/home/siddhik/git/fst/research/backtester/artifacts/bb-regime-20260321-144627/tune-all.json`
- 완료된 auto-research report 기준 최고 수익: `bbrev1h-c1-deep-wide`, `+3.88%`, `MDD 2.41%`, `14.2 trades`
  - source: `/home/siddhik/git/fst/research/backtester/artifacts/bb-seeded-auto-deep-20260321-175832/weekly/report.json`

## 해석

- `tune-all` 상위 seed는 net return이 가장 강하다. 다만 오래된 파라미터 공간이라 `entryBenchmarkLead*`, `softExit*`, `exitRelativeFragilityWeight` 같은 최신 축이 빠진 경우가 있다.
- `auto-report` 상위 seed는 최신 축이 모두 살아 있다. 재실행할 때는 `tune-all` 고수익 seed와 `auto-report` 최신 seed를 같이 넣는 편이 낫다.
- 주간은 `deep-wide`, `high-activation`, `balanced` 세 코너를 모두 유지하는 게 좋다.
- 일간은 `tune-all` 고수익 seed와 `mid-breadth-gated` 계열을 같이 넣는 게 좋다.
- 시간은 아직 약하지만 `bb-hourly-cached-03-wf`, `bb-hourly-cached-21-wf`, `block:bb-reversion-1h-hourly-04` 세 개는 계속 seed로 남길 가치가 있다.

## 추천 seed 묶음

### Weekly

| candidateId | source | net | MDD | trades | pwr |
|---|---|---:|---:|---:|---:|
| `bb-weekly-cached-16-wf` | `tune-all` | `+10.47%` | `6.25%` | `37.7` | `1.0` |
| `bb-weekly-cached-05-wf` | `tune-all` | `+7.85%` | `3.20%` | `69.7` | `1.0` |
| `bbrev1h-c1-deep-wide` | `auto-report` | `+3.88%` | `2.41%` | `14.2` | `1.0` |
| `bbrev1h-c2-high-activation-reclaim` | `auto-report` | `+3.60%` | `3.66%` | `65.6` | `0.8` |

### Daily

| candidateId | source | net | MDD | trades | pwr |
|---|---|---:|---:|---:|---:|
| `bb-daily-cached-23-wf` | `tune-all` | `+4.81%` | `3.02%` | `25.0` | `1.0` |
| `bb-daily-cached-10-wf` | `tune-all` | `+2.74%` | `3.82%` | `50.7` | `1.0` |
| `bbd-mid-breadth-gated-10` | `auto-report` | `+1.06%` | `0.97%` | `10.4` | `0.8` |
| `bbd-next-09-seed0219-midpoint-hybrid` | `auto-report` | `+0.99%` | `0.87%` | `4.8` | `0.8` |

### Hourly

| candidateId | source | net | MDD | trades | pwr |
|---|---|---:|---:|---:|---:|
| `bb-hourly-cached-03-wf` | `tune-all` | `+2.62%` | `4.38%` | `61.7` | `0.67` |
| `bb-hourly-cached-21-wf` | `tune-all` | `+2.01%` | `2.28%` | `51.7` | `0.67` |
| `block:bb-reversion-1h-hourly-04` | `auto-report` | `+1.02%` | `0.85%` | `10.2` | `1.0` |

## 재실행 방법

### 직접 block auto-research

```bash
cd /home/siddhik/git/fst/research/backtester

node --import tsx src/index.ts \
  --auto-research \
  --stage block \
  --auto-research-mode walk-forward \
  --auto-research-family block:bb-reversion-1h \
  --auto-research-iterations 3 \
  --auto-research-candidates 8 \
  --auto-research-parallelism 8 \
  --holdout-days 365 \
  --training-days 365 \
  --step-days 90 \
  --market-limit 12 \
  --llm-provider codex \
  --llm-model medium \
  --auto-research-llm-timeout-ms 120000 \
  --auto-research-seed-artifact /home/siddhik/git/fst/research/backtester/research/2026-03-22-bb-top-return-seeds.json \
  --auto-research-seed-candidates 4 \
  --auto-research-candidate-min-distance 0.08 \
  --auto-research-output /tmp/fst-bb-weekly-rerun
```

`block:bb-reversion-1h-daily`, `block:bb-reversion-1h-hourly`로 family만 바꿔서 재사용하면 된다.

### 배치 스크립트

기본 seed artifact도 이 catalog를 보도록 바꿨다.

- `/home/siddhik/git/fst/scripts/run-bb-seeded-auto-research-batch.sh`
- `/home/siddhik/git/fst/scripts/run-bb-seeded-auto-research-deadline.sh`

따라서 별도 인자 없이 돌려도 위 seed 묶음을 기본으로 쓴다.

## source artifact 빠른 참조

- weekly tune top: `/home/siddhik/git/fst/research/backtester/artifacts/bb-regime-20260321-144627/tune-all.json`
- weekly auto top: `/home/siddhik/git/fst/research/backtester/artifacts/bb-seeded-auto-deep-20260321-175832/weekly/report.json`
- weekly tradeful auto: `/home/siddhik/git/fst/research/backtester/artifacts/bb-seeded-auto-batch-20260321-170009/weekly/report.json`
- daily auto top: `/home/siddhik/git/fst/research/backtester/artifacts/bb-seeded-auto-deep-rerun-20260321-1815/daily/report.json`
- daily hybrid auto: `/home/siddhik/git/fst/research/backtester/artifacts/bb-seeded-auto-fileprompts-20260321-194718/daily/report.json`
- hourly auto top: `/home/siddhik/git/fst/research/backtester/artifacts/bb-seeded-auto-fileprompts-20260321-194718/hourly/report.json`

## 메모

- 최신 배치 `/home/siddhik/git/fst/research/backtester/artifacts/bb-seeded-auto-deadline-20260322-011206` 는 아직 진행 중이므로 여기엔 포함하지 않았다.
- 전체 파라미터 벡터는 JSON catalog에 모두 들어 있다.
