# fst

Upbit KRW 현물 기준의 롱 전용 멀티 전략 시스템이다. 현재 저장소는 `docs/multi-strategy-system-design.md`를 기준으로 다음 계층을 갖는다.

## 시스템 구조

- `packages/shared/src`
  - 공통 도메인 타입, 전략 인터페이스, 포트폴리오 intent 타입, 이벤트 규약, 공용 `OrderStateMachine`
- `research/backtester/src/multi-strategy`
  - full-grid normalizer
  - point-in-time universe snapshot builder
  - `PortfolioEngine`, `SleeveAllocator`, `ConflictResolver`, `RiskEngine`
  - `OrderPlanner`, `ExecutionRouter`
  - `StrategyAdapter`
  - Relative Strength Rotation / Breakout Rotation / Micro Strategy
  - ghost/funnel/raw event logging이 포함된 멀티 전략 백테스트 엔진
- `services/paper-trader/src/live-reconciliation.ts`
  - 공용 주문 상태 머신 snapshot 기준의 live/paper reconciliation helper

## 실행 방법

루트 기준:

```bash
pnpm --filter @fst/backtester test
pnpm --filter @fst/backtester typecheck
pnpm --filter @fst/paper-trader test
```

멀티 전략 리포트 생성:

```bash
pnpm --filter @fst/backtester dev -- --multi-strategy-report --universe krw-top --market-limit 5 --limit 1500
```

기존 단일 전략 리포트/백테스트 명령은 그대로 유지된다.

AI native auto research 실행:

```bash
pnpm --filter @fst/backtester dev -- --auto-research --auto-research-iterations 3 --auto-research-candidates 3 --auto-research-parallelism 3 --market-limit 10 --limit 20000 --holdout-days 365 --auto-research-output research/backtester/artifacts/auto-research/latest --auto-research-allow-feature-cache
```

기본 LLM provider는 `codex`다. `--llm-model`은 지정하지 않으면 provider 기본 모델을 사용한다.

옵션:

- `--auto-research-family <familyId>`: 특정 전략 패밀리만 연구
- `--auto-research-mode holdout|walk-forward`
- `--auto-research-parallelism <n>`
- `--llm-provider <provider>`: 기본값 `codex`
- `--llm-model <model>`: 지정하지 않으면 provider 기본값 사용
- `--auto-research-llm-timeout-ms <ms>`: 기본값 `300000`
- `--auto-research-output <dir>`
- `--auto-research-resume <dir>`
- `--auto-research-allow-data-collection`
- `--auto-research-allow-feature-cache`
- `--auto-research-allow-code-mutation`
- `--auto-research-min-trades <n>`
- `--auto-research-min-net-return <decimal>`
- `--auto-research-max-no-trade-iterations <n>`

auto research artifact:

- `run.log`: 실행 로그
- `status.json`: 현재 phase / iteration / 진행률
- `leaderboard.json`: 현재까지 최고 후보 순위
- `report.json`
- `report.md`
- `report.html`: 상태와 leaderboard가 포함된 HTML 대시보드
- `run-state.json`: resume 상태 저장

## 리포트 생성 방법

`--multi-strategy-report`는 15m/5m/1m 캔들을 함께 읽어서 다음을 JSON으로 출력한다.

- 포트폴리오 성과 지표
- funnel stage 집계
- ghost summary
- 텍스트 형태의 CLI report

핵심 지표:

- `grossReturn`
- `netReturn`
- `turnover`
- `winRate`
- `avgHoldBars`
- `maxDrawdown`
- `feePaid`
- `slippagePaid`
- `rejectedOrdersCount`
- `cooldownSkipsCount`

Auto research artifact:

- `report.json`
- `report.md`
- `report.html`
- `run-state.json`
- `status.json`
- `iteration-XX.json`
- `catalog.json`
- `preparation-results.json`
- `code-agent/code-tasks.json`
- `iteration-XX/evaluations/*.json`
- `iteration-XX/validation/validation-results.json`

## backtest / paper / live 차이

- `backtest`
  - full-grid candle과 PTI universe를 사용한다.
  - same-bar fill을 금지하고 next execution bar 기준으로만 체결한다.
  - `ExecutionRouter`와 공용 `OrderStateMachine`을 사용한다.
- `paper`
  - 주문 상태 전이는 live와 같은 상태 머신을 사용하고 거래소 응답만 mock 또는 paper execution으로 대체한다.
  - reconciliation은 `services/paper-trader/src/live-reconciliation.ts` 기준으로 점검한다.
- `live`
  - 아직 order chance cache, websocket recovery, myOrder/myAsset 기반 reconcile은 확장 단계다.
  - 다만 주문 상태 전이 모델은 backtest/paper와 동일한 공용 상태 머신을 기준으로 통합했다.

## Auto Research 구조

- `research/backtester/src/auto-research`
  - `llm-adapter.ts`: `~/git/ucm`의 `llmJson` 기반 LLM 호출
  - `catalog.ts`: 즉시 실행 가능한 stable strategy family registry
  - `proposed-catalog.ts`: LLM이 제안한 family의 상태 추적
  - `preparation.ts`: 데이터 수집 / feature cache build 액션 실행
  - `orchestrator.ts`: proposal -> prepare -> backtest -> review 루프
  - `code-agent.ts`: code mutation task artifact 및 실행 경로

이 루프는 다음을 자동화한다.

- LLM이 후보 전략 제안
- 필요 시 데이터/피처 준비
- fresh process worker로 백테스트 실행
- keep/refine/discard 판단
- proposed catalog 갱신
- code mutation task 실행 및 후속 검증
- run-state 저장과 resume

## 참고 문서

- `docs/multi-strategy-system-design.md`
- `docs/portfolio-execution-design.md`
- `docs/ai-auto-research-requirements.md`
- `docs/ai-auto-research-implementation-plan.md`
- `prompts/codex_multi_strategy_prompt.txt`
