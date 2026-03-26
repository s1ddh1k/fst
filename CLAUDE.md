# CLAUDE.md

## 프로젝트 개요

**fst** — 업비트 KRW 현물 자동매매를 위한 전략 자동 연구 엔진.
사람 개입 없이 전략을 자동 생성 → 변형 → 백테스트 → 평가 → paper trading까지 연결하는 것이 핵심 목표.

## 개발 원칙

- 모든 변경은 "이것이 투자 수익에 기여하는가?"로 판단한다.
- 전략은 파라미터 7개 이하로 설계한다.
- 코드를 변경할 때는 기존 코드를 먼저 단순화한다.
- 하나의 전략이 실제로 수익을 내는지 확인한 후 다음 전략으로 넘어간다.
- 실행 가능한 최소 단위로 작업한다.

## 기술 스택

- pnpm workspace monorepo, TypeScript (ESM)
- SQLite (better-sqlite3), node --test, conventional commits

## 주요 명령어

```bash
pnpm build && pnpm typecheck    # 빌드 + 타입 체크
cd research/backtester && pnpm dev   # auto-research 실행
cd services/paper-trader && pnpm dev # paper trading 실행
```
