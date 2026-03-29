# 전략 연구 로드맵

## 현재 상태 (2026-03-30)

### 완료

**백테스터 버그 수정 및 리팩토링**
- familyId substring 매칭 버그 12개 수정
- block-families.ts 단일 소스 구조로 리팩토링 (if/else 700줄 → 10줄)
- candle-loader.ts 캔들 로딩 단일 소스
- 15m 캔들 DB 직접 로드 (5m 집계 제거)
- `--test-start/end` range 기반 로딩
- zero-volume 체결 거부, equity mark-to-market 수정
- 테스트 24개 (family 매핑, e2e 시뮬레이션, regime 감지)

**전략 개발**
- 하락장: volume-exhaustion (1h +8.82%, 15m +4.38% 하락장 절대수익)
- 횡보장: rsi-reversion (1h +3.04%)
- 상승장: donchian-breakout (1h +31.6%)

**Regime Switching (BTC 단일)**
- adaptive detector: 5가지 선행 신호 점수화 (OBV divergence, SMA, momentum, candle, volatility)
- 비대칭 threshold: bull→bear 빠르게, bear→bull 느리게
- 외부 신호: 공포탐욕지수 + 김치프리미엄 (cd=168에서 유효)
- hybrid detector: B&H default + fundamental-confirmed trailing stop
- 최적 결과: hybrid 25/30 → 6yr +1,866%, cd=72 adaptive → 6yr +672% DD 23%

**멀티마켓 포트폴리오**
- crypto-regime-gate: BTC benchmark 기반 독립 regime 감지
- rotation-only: 3yr +54.1%, DD 9.7% (내부 regime만 사용 시)
- 발견: 이중 regime 시스템 충돌 문제

### 성과 요약

| 구성 | 기간 | 수익률 | DD |
|---|---|---|---|
| BTC hybrid 25/30 | 6yr | +1,866% | 53% |
| BTC adaptive cd=72 | 6yr | +672% | 23% |
| 멀티마켓 rotation-only | 3yr | +54.1% | 9.7% |
| B&H | 6yr | +879% | ~55% |

---

## Phase 1: Regime 감지 통합 (높은 우선순위)

### 문제
market-state.ts의 regime 감지(SMA 55)와 crypto-regime-gate의 adaptive scoring(SMA 50/200)이 이중으로 존재.
두 시스템이 충돌하면 rotation 전략 성과 악화 (-11% vs +54%).

### 작업
1. market-state.ts에 `buildCryptoAdaptiveRegime()` 함수 추가
   - 기존 `buildRegimeSeries()` 유지 (bb-reversion 등 호환)
   - adaptive scoring 로직을 market-state.ts 내부로 통합
   - strategy의 `contextConfig`에서 선택 가능하게
2. rotation 전략이 adaptive regime을 사용하도록 변경
3. crypto-regime-gate.ts 제거 (market-state.ts로 통합됨)
4. 테스트: 전체 기간에서 rotation 성과 검증

### 목표
멀티마켓 rotation이 3yr +54% 이상 유지하면서, crypto regime gate 없이도 동작

---

## Phase 2: 멀티마켓 전략 최적화

### 작업
1. rotation 전략 파라미터를 auto-research로 regime별 최적화
   - 상승장 전용 파라미터 탐색
   - `entryFloor`, `exitFloor`, `switchGap` 등
2. volume-exhaustion을 멀티마켓용으로 조정
   - 알트코인 급락 패턴은 BTC와 다름
   - `dropThresholdPct`, `volumeSpikeMult` 코인별 최적화
3. 횡보장 전략 개선
   - rsi-reversion의 멀티마켓 win rate 개선
   - 또는 새로운 횡보장 전략 탐색

### 목표
멀티마켓 3yr +100% 이상

---

## Phase 3: 외부 데이터 실시간 수집

### 작업
1. 공포탐욕지수 일별 자동 수집 (alternative.me API)
2. 김치프리미엄 일별 자동 계산 (Binance BTCUSDT vs Upbit KRW-BTC)
3. 펀딩레이트 수집 (Binance futures API) — 추후 활용 여부 재평가
4. data-collector 서비스에 통합

### 목표
regime 감지에 외부 신호를 실시간으로 반영 가능한 인프라

---

## Phase 4: Paper Trading 연결

### 작업
1. regime-switching 로직을 paper-trader 서비스에 통합
2. 실시간 regime 감지 → 전략 전환 → 주문 실행
3. 멀티마켓 포트폴리오 관리 (포지션 추적, 리밸런싱)
4. 모니터링 대시보드 (현재 regime, 활성 포지션, P&L)

### 목표
백테스트와 동일한 로직으로 실시간 paper trading 운영

---

## Phase 5: 실투자 전환

### 전제 조건
- Paper trading 3개월 이상 안정 운영
- 백테스트 대비 성과 괴리 10% 이내
- 리스크 관리 체계 완비 (포지션 제한, 일일 손실 제한)

### 작업
1. 업비트 실계좌 연동
2. 점진적 자본 투입 (최소 금액부터)
3. 실시간 알림 (Slack/Discord)
4. 긴급 정지 매커니즘

---

## 기술 부채

- [ ] market-state.ts volatile 분류 크립토 최적화
- [ ] MACD signal line SMA → EMA (표준 준수)
- [ ] walk-forward universe selection의 training data leakage
- [ ] normalizeToFullGrid에서 신규 상장 코인 처리 개선
- [ ] 전략 추가 시 테스트 자동 실행 (CI/CD)
