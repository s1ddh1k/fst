# backtester

전략 백테스트 및 검증 모듈이다.

## 기능

- PostgreSQL 캔들 로더
- 레거시 전략 + scored 전략 백테스트
- scored 경로의 full-grid normalization + synthetic candle 보정
- point-in-time rolling top-N 유니버스 선택
- 단일 포지션 PortfolioCoordinator
- next-bar only ExecutionSimulator
- gross/net return, turnover, avg hold bars, fee/slippage, reject/cooldown skip 집계
- 홀드아웃 검증, 워크포워드 검증
- ghost trade study (signal count, ghost signal count, horizon별 MFE/MAE/gross/net)
- 유니버스 기반 시장 breadth / 상대강도 컨텍스트
- 시장 feature batch 적재 및 precomputed feature 우선 로드
- 별도 execution layer에서 체결 가격 계산
- bootstrap 신뢰구간 검증
- 랜덤 진입 벤치마크 검증
- 변동성 타겟 포지션 사이징
- drawdown 서킷 브레이커

## 현재 scored 아키텍처

- 기준 전략군:
  - `relative-momentum-pullback`
  - `leader-pullback-state-machine`
  - `relative-breakout-rotation`
- 의사결정 주기: `1h` 닫힌 바만 허용 (`5m` scored 실행은 거부)
- 유니버스: 최근 rolling 거래대금 기준 point-in-time top-N
- 유동성 판단: rolling quote volume 기반 `liquiditySpread`
- 회복 확인: baseline은 최근 3 bars 안의 EMA20 reclaim 허용
- follow-up 평가는 walk-forward + ghost trade study + sufficiency/performance/robustness 기준을 사용
- 포지션 제약: 단일 포지션만 허용
- 체결 규칙: same-bar fill 금지, 기본 `t+1` bar open 체결
- 거래 비용: fee, slippage, KRW tick size, 최소 주문 금액 반영
- 기존 `residual-reversion`은 호환 alias만 유지하고 기본 스윕 대상에서는 제외

## Scored 전략 CLI

### 기준선 평가

단일 전략을 universe-level single-position 구조로 평가한다. bootstrap + 랜덤 벤치마크 포함.

```bash
pnpm --filter @fst/backtester dev \
  --scored-baseline \
  --strategy relative-momentum-pullback \
  --timeframe 1h \
  --universe krw-top \
  --market-limit 10 \
  --holdout-days 30 \
  --training-days 60
```

### 파라미터 스윕

`--sweep-all`은 baseline 54개, leader state machine 81개, breakout rotation 81개 그리드를 탐색한다.

```bash
pnpm --filter @fst/backtester dev \
  --scored-sweep --sweep-all \
  --timeframe 1h \
  --universe krw-top \
  --market-limit 10 \
  --holdout-days 30 \
  --training-days 60 \
  --save-regime
```

### Walk-forward 검증

롤링 윈도우 out-of-sample 테스트.

```bash
pnpm --filter @fst/backtester dev \
  --scored-walk-forward --sweep-all \
  --timeframe 1h \
  --universe krw-top \
  --market-limit 10 \
  --holdout-days 30 \
  --training-days 90 \
  --step-days 14
```

### Follow-up 비교 리포트

세 scored 전략을 동일한 walk-forward 파이프라인에서 비교하고 markdown + JSON + CSV 산출물을 남긴다.

```bash
pnpm --filter @fst/backtester dev \
  --strategy-followup-report \
  --timeframe 1h \
  --universe krw-top \
  --market-limit 10 \
  --holdout-days 30 \
  --training-days 90 \
  --step-days 14
```

산출물:

- `docs/strategy-followup-report.md`
- `research/backtester/output/strategy-followup-report.json`
- `research/backtester/output/strategy-followup-summary.csv`
- `research/backtester/output/strategy-followup-folds.csv`

### 결과 저장

- `--save-regime` — `scored-holdout-recommendation` 또는 `scored-walk-forward-recommendation`으로 저장
- `--paper-candidates` — `paper-trading-candidate`로 저장하여 paper-trader에서 바로 실행 가능

저장되는 scored 추천 타입은 `universe_scored`이며, paper-trader에서 universe single-position runtime으로 실행된다.

출력 JSON에는 다음 지표가 포함된다.

- `train`, `test`
- `signalCount`
- `ghostSignalCount`
- `turnover`
- `avgHoldBars`
- `feePaid`
- `slippagePaid`
- `rejectedOrdersCount`
- `cooldownSkipsCount`

### 검증 기준

- bootstrap p-value < 0.05
- 랜덤 벤치마크 90%ile 이상
- trade-to-parameter ratio >= 10:1
- 과도한 turnover 없이 비용 차감 후 net return 유지

## 테스트

```bash
pnpm --filter @fst/backtester test
```

## 레거시 전략 CLI

기존 12개 전략의 기준선 비교용.

```bash
# 기준선 평가
pnpm --filter @fst/backtester dev \
  --baseline-evaluate \
  --strategy zscore-rsi-trend-pullback \
  --timeframe 5m \
  --universe krw-top

# 후보 탐색
pnpm --filter @fst/backtester dev \
  --candidate-sweep --sweep-all \
  --timeframe 5m \
  --universe krw-top
```

## 시장 feature 적재

```bash
pnpm --filter @fst/backtester dev \
  --build-market-features \
  --strategy integrated-multi-factor \
  --timeframe 5m \
  --universe krw-top \
  --market-limit 10 \
  --min-candles 500 \
  --limit 4000
```

## 유니버스 포트폴리오 백테스트

```bash
pnpm --filter @fst/backtester dev \
  --universe-cross-sectional \
  --save-regime \
  --paper-candidates \
  --timeframe 5m \
  --universe krw-top \
  --max-positions 4 \
  --rebalance-bars 3 \
  --min-score 0.05
```
