# AI Native Auto Research Implementation Plan

버전: v0.1  
기준 문서: [ai-auto-research-requirements.md](/home/eugene/git/fst/docs/ai-auto-research-requirements.md)

---

## 1. 구현 목표

이 계획의 목표는 현재 백테스터 위에 다음 루프를 실제 코드로 올리는 것이다.

```text
LLM research/proposal
  -> data/cache preparation
  -> strategy/catalog/code change
  -> backtest
  -> result review
  -> refine / discard / promote
  -> next iteration
```

핵심은 “수동 리서치 보조 도구”가 아니라 **자동 연구 실행기**를 만드는 것이다.

---

## 2. 현재 상태

이미 있는 것:

- Upbit KRW 현물 백테스트/수집 인프라
- `ScoredStrategy` 기반 단일 전략 연구 경로
- 멀티전략 백테스트 경로
- full-grid normalization
- point-in-time universe
- execution / same-bar 금지 구조
- feature pipeline
- 데이터 수집기

부족한 것:

- LLM 연구 오케스트레이터
- LLM 제안 -> 실행 가능한 후보 변환
- 자동 데이터 준비 액션 체인
- 자동 code-change 루프
- 동적 전략 카탈로그
- artifact 중심 연구 상태 관리

---

## 3. 단계별 구현 계획

### Phase 1. Auto Research Core

목표:

- LLM 제안
- 실행 가능한 후보 생성
- 백테스트 실행
- review verdict

구현 항목:

- `research/backtester/src/auto-research/types.ts`
- `research/backtester/src/auto-research/catalog.ts`
- `research/backtester/src/auto-research/prompt-builder.ts`
- `research/backtester/src/auto-research/llm-adapter.ts`
- `research/backtester/src/auto-research/orchestrator.ts`
- `research/backtester/src/auto-research/index.ts`
- CLI 엔트리 `--auto-research`

완료 기준:

- LLM이 후보 전략 1~N개를 JSON으로 제안
- 시스템이 후보를 자동 백테스트
- 결과를 다시 LLM이 review
- artifact 생성

### Phase 2. Data/Feature Preparation Loop

목표:

- 연구 도중 필요한 데이터 준비 액션을 자동 수행

구현 항목:

- `sync_latest_batch`
- `backfill_batch`
- `build_feature_cache`
- action 결과 artifact 저장

완료 기준:

- LLM이 preparation action을 제안 가능
- 시스템이 허용 범위 내에서 자동 실행 가능
- 실행 결과가 다음 review에 반영됨

### Phase 3. Proposed Catalog

목표:

- 실행 가능한 고정 카탈로그를 넘어서, LLM이 새 전략 패밀리를 제안하고 상태를 관리

구현 항목:

- `stable catalog`
- `proposed catalog`
- strategy family state machine
  - `proposed`
  - `implemented`
  - `validated`
  - `discarded`
- proposal artifact 저장

완료 기준:

- LLM이 새 전략 패밀리 명세를 제안 가능
- 구현 전/후 상태가 추적됨

### Phase 4. Code Agent Loop

목표:

- LLM이 코드 수정까지 직접 수행하는 연구 루프 추가

구현 항목:

- code task planner
- file search / targeted edit / test rerun
- bug-fix task type
- strategy-implementation task type
- patch validation

완료 기준:

- 버그를 발견하면 관련 파일을 찾아 수정 가능
- 새 전략 패밀리 구현을 위한 코드 생성/수정 가능
- 테스트와 재실행까지 이어짐

### Phase 5. Research Governance

목표:

- 자동 연구가 무한히 산만해지지 않도록 통제

구현 항목:

- experiment budget
- iteration budget
- promotion criteria
- discard criteria
- duplicate candidate suppression
- artifact indexing

완료 기준:

- 장기 실행에서도 중복 탐색과 난잡한 실험이 줄어듦
- 승격/폐기 의사결정이 일관성 있게 남음

---

## 4. 모듈 설계

### 4.1 LLM Adapter

역할:

- `~/git/ucm`의 `spawnLlm`/`llmJson` 기반으로 LLM 호출
- prompt 생성과 결과 파싱
- provider/model 주입

요구사항:

- JSON strict response
- prompt versioning
- 실패 시 명확한 에러

### 4.2 Strategy Catalog

역할:

- 실행 가능한 전략 패밀리 정의
- 파라미터 스키마 정의
- LLM proposal 검증
- proposal -> 실제 `ScoredStrategy` 변환

확장 방향:

- stable catalog
- proposed catalog
- generated catalog

### 4.3 Preparation Executor

역할:

- 데이터 수집기 호출
- feature pipeline 호출
- 필요 데이터 준비

제약:

- 허용된 액션만 실행
- 실행 로그 저장
- 실패 시 iteration artifact에 기록

### 4.4 Evaluator

역할:

- holdout / walk-forward 백테스트 실행
- 핵심 메트릭 요약
- 후보 간 비교 가능 형식 제공

메트릭:

- `netReturn`
- `grossReturn`
- `maxDrawdown`
- `turnover`
- `tradeCount`
- `signalCount`
- `ghostSignalCount`
- `bootstrap`
- `randomBenchmark`

### 4.5 Review Engine

역할:

- LLM이 결과를 받아
  - `keep_searching`
  - `promote_candidate`
  - `stop_no_edge`
  중 하나를 결정

추가 역할:

- 실패한 후보 retirement
- 다음 후보 배치 제안
- 다음 preparation action 제안

### 4.6 Code Agent

역할:

- 버그 수정
- 전략 구현
- 카탈로그 확장
- 테스트 보강

안전장치:

- 변경 전후 artifact 기록
- 테스트 실패 시 promote 금지
- 지나치게 넓은 변경은 chunking

---

## 5. CLI 계획

필수 명령:

```bash
pnpm --filter @fst/backtester dev -- --auto-research
```

옵션 예:

```bash
--auto-research
--auto-research-iterations 5
--auto-research-candidates 3
--auto-research-family relative-momentum-pullback
--auto-research-family leader-pullback-state-machine
--llm-provider codex
--llm-model medium
--auto-research-mode holdout
--auto-research-output research/backtester/artifacts/auto-research/run-001
--auto-research-allow-data-collection
--auto-research-allow-feature-cache
--auto-research-allow-code-mutation
```

추가 예정:

```bash
--auto-research-proposed-catalog
--auto-research-review-only
--auto-research-resume <artifact-dir>
```

---

## 6. Artifact 설계

경로 예:

```text
research/backtester/artifacts/auto-research/<timestamp>/
  report.json
  report.md
  iteration-01.json
  iteration-02.json
  preparation-results.json
  proposed-catalog.json
  code-changes.json
```

최소 기록:

- config
- family set
- candidate market pool
- proposal
- preparation actions
- evaluations
- review verdict
- best candidate

---

## 7. 테스트 계획

### 단위 테스트

- prompt/result parsing
- candidate validation
- catalog parameter clamping
- preparation action parsing
- review verdict parsing

### 오케스트레이터 테스트

- mock LLM으로 proposal -> evaluation -> review 흐름 검증
- duplicate candidate suppression
- promote candidate 종료
- stop_no_edge 종료

### 통합 테스트

- 실제 holdout backtest 1회
- artifact 생성 검증
- feature cache build 경로 검증

### 추후 테스트

- code-agent patch loop
- proposed catalog state transitions

---

## 8. 우선순위

가장 먼저 해야 할 것:

1. auto-research core를 완성
2. artifact를 남기게 만들기
3. preparation action을 안정화
4. proposed catalog 도입
5. code-agent 루프 추가

이유:

- 먼저 “LLM 제안 -> 자동 실행 -> 자동 평가”가 돌아야 한다.
- 그 다음에야 코드 수정 자동화와 카탈로그 확장이 의미가 있다.

---

## 9. 리스크

### 9.1 LLM 산만함

대응:

- strict JSON schema
- family/parameter bounds
- duplicate suppression
- iteration budget

### 9.2 엉뚱한 코드 수정

대응:

- patch validation
- tests required
- artifact diff 저장

### 9.3 과도한 탐색 비용

대응:

- candidate per iteration 제한
- preloaded data 재사용
- feature cache build 선택적 실행

### 9.4 “말만 하는” 리서치

대응:

- proposal만으로 종료 금지
- 반드시 executable candidate 또는 action 포함

---

## 10. 최종 완료 기준

다음이 되면 초기 버전이 실질적으로 완성된 것으로 본다.

- LLM이 아이디어를 제안한다.
- 시스템이 데이터를 준비한다.
- 후보를 백테스트한다.
- 결과를 바탕으로 폐기/조정/승격을 결정한다.
- 필요하면 전략 코드/버그 수정 작업으로 넘어갈 준비가 되어 있다.
- 전략 카탈로그가 고정이 아니라 확장 가능한 상태 모델을 갖는다.
- 모든 과정이 artifact로 남는다.
