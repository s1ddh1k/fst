# desktop

Electron 기반 데스크톱 앱 패키지다.

현재 포함 기능:

- `개요 / 전략 / 세션 / 운영` 허브 기반 화면 구조
- `tmux` 워크스페이스 상태 조회
- 최신 collector / paper session 로그 파일 표시
- 로컬 운영 런북 커맨드 노출
- 앱 시작 시 `paper-trader serve` 자동 구동 및 종료 시 정리
- `paper-trader` 로컬 API 추천 목록 조회
- 최근 paper session 목록 조회
- session 상태/포지션/최근 주문 조회
- 추천 전략 기준 새 session 생성
- 선택 session 실시간 실행 트리거

실행 전제:

1. 기본값에서는 데스크톱 앱이 `paper-trader`를 직접 띄운다.
2. `DESKTOP_API_BASE_URL`을 별도로 주면 해당 주소를 외부 API로 사용한다.
3. `tmux` 운영 보드는 `paper-trader` 상태와 별개로 열린다.

기본 API 주소:

- `http://127.0.0.1:8787`

실행:

```bash
pnpm --filter @fst/desktop build
pnpm --filter @fst/desktop dev
pnpm --filter @fst/desktop smoke
```

현재 렌더러는 React 기반 데스크톱 콘솔이며, 정보 구조는 [docs/information-architecture.md](/home/eugene/git/fst/docs/information-architecture.md)를 따른다.

스모크 테스트:

- Playwright의 Electron 런처로 창을 띄운다.
- 운영 보드, 추천 전략, 최근 세션, 세션 상태 패널 렌더링을 확인한다.
- 스크린샷을 [artifacts/smoke.png](/home/eugene/git/fst/apps/desktop/artifacts/smoke.png)에 저장한다.
