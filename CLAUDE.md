# CLAUDE.md

## 프로젝트 개요

**fst** — 업비트 KRW 현물 자동매매를 위한 전략 자동 연구 엔진.
사람 개입 없이 전략을 자동 생성 -> 변형 -> 백테스트 -> 평가 -> paper trading까지 연결하는 것이 핵심 목표.

## 기술 스택

- **Monorepo**: pnpm workspace
- **언어**: TypeScript (ESM)
- **DB**: SQLite (better-sqlite3, 로컬 파일)
- **빌드**: tsc + tsx (런타임)
- **테스트**: node --test (내장 test runner)
- **커밋 규칙**: conventional commits (commitlint)

## 패키지 구조

| 패키지 | 역할 |
|---|---|
| `research/backtester` | 핵심 — 백테스트 엔진, auto-research 루프, 멀티전략 시스템 |
| `services/data-collector` | 업비트 시세 데이터 수집 |
| `services/paper-trader` | 모의매매 실행 |
| `packages/shared` | 공통 유틸 |
| `apps/desktop` | 데스크톱 UI (후순위) |

## 주요 명령어

```bash
pnpm build          # 전체 빌드
pnpm dev            # 전체 dev 모드
pnpm typecheck      # 타입 체크
pnpm -r lint        # 린트

# 백테스터
cd research/backtester
pnpm dev            # auto-research 실행
pnpm test           # 테스트 실행
pnpm build          # 빌드

# paper-trader
cd services/paper-trader
pnpm dev            # paper trading 실행
pnpm test           # 테스트 실행

# DB — SQLite 로컬 파일, 별도 서버 불필요
```

## 핵심 모듈: auto-research (`research/backtester/src/auto-research/`)

LLM 기반 자동 전략 연구 루프:

- `orchestrator.ts` — 연구 루프 전체 조율
- `code-agent.ts` / `llm-adapter.ts` / `cli-llm.ts` — LLM 연동으로 전략 코드 자동 생성
- `evaluate-worker.ts` — 후보 전략 백테스트 평가
- `ranking.ts` — 전략 랭킹/선별
- `catalog.ts` / `proposed-catalog.ts` — 전략 카탈로그 관리
- `portfolio-evaluator.ts` / `portfolio-runtime.ts` — 포트폴리오 레벨 평가
- `walk-forward-config.ts` — Walk-forward 검증
- `report-html.ts` — 결과 리포트 생성
- `run-manager.ts` — 실행 관리
- `prompt-builder.ts` — LLM 프롬프트 구성

## 핵심 모듈: multi-strategy (`research/backtester/src/multi-strategy/`)

레짐별 멀티타임프레임 전략 시스템:

- 전략 구현체: LeaderPullback, BreakoutRotation, RelativeMomentum, ResidualReversion 등
- `RegimeGatedStrategy.ts` — 시장 레짐별 전략 전환
- `PortfolioEngine.ts` / `RiskEngine.ts` / `SleeveAllocator.ts` — 포트폴리오 운용/리스크 관리
- `MultiStrategyBacktestEngine.ts` — 멀티전략 백테스트

## 우선순위 (AGENTS.md 참조)

1. auto-research 루프 자동화
2. 무인 실행, 재시작, 로그/아티팩트 누적
3. 레짐별 멀티타임프레임 유니버스 포트폴리오 연구 구조 확장
4. 전략 생성/변형/평가 throughput 개선
5. 랭킹 및 승격 규칙 고도화
6. paper trading 연결
