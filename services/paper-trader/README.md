# paper-trader

실시간 모의투자 엔진 서비스다.

## 기능

- 활성 추천 전략 조회
- paper session 생성 / 실행 / 상태 조회
- 포지션 및 최근 주문 조회
- Electron 앱 연동용 로컬 API 제공
- 닫힌 캔들 기준 신호 생성 후 새 버킷 첫 틱에서 체결
- 실시간 market breadth / relative strength snapshot 적재
- 별도 execution model과 ops guard를 통한 live runtime 분리

### Scored 전략 지원

현재 scored 전략은 `relative-momentum-pullback`, `leader-pullback-state-machine`, `relative-breakout-rotation`을 지원하며, 기존 `residual-reversion` 추천도 호환 처리된다.
scored 전략은 자동으로 감지되어 다음이 적용된다:

- scored 경로는 `1h` 캔들만 허용된다.
- 변동성 타겟 포지션 사이징 (conviction 기반)
- drawdown 서킷 브레이커 (warn 5% / kill 10%)
- `universe_scored` 추천은 단일 포지션 universe runtime으로 실행된다.
- 세션 재개 시 `current_balance - open_notional` 기준으로 가용 현금을 복원한다.

## CLI

```bash
# 추천 조회
pnpm --filter @fst/paper-trader dev show-recommendations \
  --regime paper-trading-candidate --timeframe 5m

# 세션 시작 (단일 종목)
pnpm --filter @fst/paper-trader dev start-session \
  --market KRW-BTC --regime paper-trading-candidate --timeframe 5m

# 세션 시작 (유니버스 포트폴리오)
pnpm --filter @fst/paper-trader dev start-session \
  --regime paper-trading-candidate --universe krw-top --timeframe 5m

# 세션 시작 (scored universe, 1h only)
pnpm --filter @fst/paper-trader dev start-session \
  --regime paper-trading-candidate --universe krw-top --timeframe 1h

# 세션 실행
pnpm --filter @fst/paper-trader dev run-session --session-id 10 --max-events 500

# 상태 확인
pnpm --filter @fst/paper-trader dev status --session-id 10

# HTTP 서버 실행
pnpm --filter @fst/paper-trader dev serve
```

## API

```bash
# 추천 조회
curl http://127.0.0.1:8787/recommendations?regime=paper-trading-candidate&timeframe=5m&limit=5

# 스냅샷 조회
curl http://127.0.0.1:8787/recommendation-snapshots?limit=10

# 세션 목록
curl http://127.0.0.1:8787/sessions?limit=10

# 세션 상세
curl http://127.0.0.1:8787/sessions/10
```

## 테스트

```bash
pnpm --filter @fst/paper-trader test
```
