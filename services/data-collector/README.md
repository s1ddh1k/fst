# data-collector

업비트 과거 시세 데이터 수집 서비스다.

예정 기능:

- 마켓 목록 조회
- 캔들 데이터 수집
- 누락 구간 재수집
- 수집 로그 저장

초기 구현은 Node.js + TypeScript CLI 형태로 진행한다.

초기 엔트리포인트:

- `src/index.ts`
- `src/upbit-client.ts`
- `src/config.ts`

현재 지원 명령:

- `sync-markets`
- `fetch-candles --market KRW-BTC --timeframe 1d --count 30`
- `sync-latest --market KRW-BTC --timeframe 1d`
- `backfill --market KRW-BTC --timeframe 1d --pages 10`
- `backfill-batch --markets KRW-BTC,KRW-ETH --timeframes 1h,1d --pages 10`
- `sync-latest-batch --markets KRW-BTC,KRW-ETH --timeframes 1h,1d`
- `backfill-default`
- `sync-latest-default`
- `run-overnight --pages 10`
- `status`
- `scan-gaps --market KRW-BTC --timeframe 1d`
- `scan-gaps-default`
- `refresh-universe --quote KRW --limit 30 --name krw-top`

운영 보강:

- 요청 재시도
- `Remaining-Req` 헤더 기반 rate limit 조절
- 429/5xx 백오프
- 기본 마켓/타임프레임 환경변수 지원
- DB 기반 유니버스 자동 선택
- `system_logs` 기록
- 상태 조회 명령
- 기본 누락 구간 탐지

장시간 실행:

- [run-overnight-backfill.sh](/home/eugene/git/fst/infra/scripts/run-overnight-backfill.sh)
- [check-collector-status.sh](/home/eugene/git/fst/infra/scripts/check-collector-status.sh)
