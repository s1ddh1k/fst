# paper-trader

실시간 모의투자 엔진 서비스다.

현재 포함 기능:

- 활성 추천 전략 조회
- 활성 추천 스냅샷 요약 조회
- paper session 생성 / 실행 / 상태 조회
- 포지션 및 최근 주문 조회
- Electron 앱 연동용 로컬 API 제공

CLI 예시:

```bash
pnpm --filter @fst/paper-trader dev show-recommendations --regime paper-trading-candidate --timeframe 5m
pnpm --filter @fst/paper-trader dev show-recommendation-snapshots --limit 10
pnpm --filter @fst/paper-trader dev start-session --market KRW-BTC --regime paper-trading-candidate --timeframe 5m
pnpm --filter @fst/paper-trader dev status --session-id 10
```

API 예시:

```bash
curl http://127.0.0.1:8787/recommendations?regime=paper-trading-candidate&timeframe=5m&limit=5
curl http://127.0.0.1:8787/recommendation-snapshots?limit=10
curl http://127.0.0.1:8787/sessions?limit=10
```
