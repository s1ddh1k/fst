# fst

업비트 API 기반 자동매매 연구 및 Electron 앱 프로젝트다.

현재 목표는 다음 순서로 시스템을 구축하는 것이다.

1. 과거 시세 데이터 수집
2. 전략 백테스트 및 검증
3. 실시간 모의투자
4. Electron 데스크톱 앱 연동
5. 이후 실거래 확장

## 문서

- [프로젝트 계획](/home/eugene/git/fst/docs/project-plan.md)
- [MVP 기능 명세](/home/eugene/git/fst/docs/mvp-spec.md)
- [기술 설계](/home/eugene/git/fst/docs/technical-design.md)
- [작업 분해](/home/eugene/git/fst/docs/work-breakdown.md)
- [연구 로드맵](/home/eugene/git/fst/docs/research-roadmap.md)

## 저장소 구조

```text
apps/
  desktop/           Electron 데스크톱 앱
services/
  data-collector/    업비트 과거 데이터 수집
  paper-trader/      실시간 모의투자 엔진
research/
  backtester/        백테스트 엔진
  strategies/        전략 구현
packages/
  shared/            공통 타입 및 설정
infra/
  db/                DB 스키마 및 초기화 스크립트
  scripts/           로컬 운영 스크립트
docs/                프로젝트 문서
```

## 현재 상태

현재는 `데이터 수집기`와 `백테스터`의 최소 동작 경로를 만든 상태다.

다음 구현 우선순위는 아래와 같다.

1. 팩터 1차 확장
2. 조합형 전략 템플릿 구현
3. 워크포워드 포함 대량 탐색기 구현
4. 후보 압축 및 추천 저장 구조 정리
5. 실시간 모의투자 엔진 구현
6. Electron 앱 구현

## 로컬 데이터베이스

로컬 개발용 PostgreSQL은 Docker Compose로 실행한다.

```bash
docker compose up -d
```

초기 스키마는 [infra/db/init.sql](/home/eugene/git/fst/infra/db/init.sql)에 정의되어 있으며, 컨테이너 최초 기동 시 자동 적용된다.

## 장기 데이터 수집

밤새 백필을 돌릴 때는 아래 스크립트를 사용한다.

```bash
bash infra/scripts/run-overnight-backfill.sh 10
```

상태 확인:

```bash
bash infra/scripts/check-collector-status.sh
pnpm --filter @fst/data-collector dev status
pnpm --filter @fst/data-collector dev scan-gaps --market KRW-BTC --timeframe 1d
```

## tmux 운영 워크스페이스

로컬 운영용 tmux 세션은 아래 스크립트로 정리한다.

```bash
bash infra/scripts/tmux-fst.sh up
bash infra/scripts/tmux-fst.sh attach
bash infra/scripts/tmux-fst.sh status
```

기본 세션 이름은 `fst`이며 `overview`, `desktop`, `collector`, `paper`, `logs` 윈도우를 만든다.

## 실행 원칙

- UI보다 데이터와 검증 체계를 먼저 만든다.
- 실거래 기능은 MVP 이후에 추가한다.
- 렌더러 프로세스에 민감정보를 노출하지 않는다.
- 앱과 엔진은 TypeScript 중심 단일 스택으로 유지한다.
