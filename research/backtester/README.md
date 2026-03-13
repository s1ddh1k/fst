# backtester

전략 백테스트 및 검증 모듈이다.

예정 기능:

- 캔들 데이터 로딩
- 전략 실행
- 비용 반영
- 성능 지표 계산
- 홀드아웃 검증 결과 생성

현재 구현:

- PostgreSQL 캔들 로더
- 이동평균 교차, 변동성 돌파, RSI 평균회귀 백테스트
- 수익률, 최대 낙폭, 거래 수, 승률 계산
- 최근 N일 홀드아웃 검증
- `backtest_runs`, `backtest_metrics` 저장
- 다중 전략 비교 실행

## 현재 권장 CLI 흐름

기준선 평가와 후보 탐색은 분리해서 쓴다.

### 기준선 평가

정확한 파라미터를 고정해서 같은 전략을 반복 검증할 때:

```bash
pnpm --filter @fst/backtester dev \
  --baseline-evaluate \
  --strategy zscore-rsi-trend-pullback \
  --parameters-json '{"zScoreWindow":20,"minNegativeZScore":-1.75,"exitZScore":0,"rsiPeriod":14,"maxEntryRsi":35,"exitRsi":55,"volatilityWindow":20,"maxVolatility":0.03,"stopLossPct":0.025,"maxHoldBars":36,"trendWindow":50,"momentumLookback":20,"minMomentum":-0.01}' \
  --timeframe 5m \
  --universe krw-top \
  --market-limit 10 \
  --holdout-days 14 \
  --training-days 30 \
  --step-days 7
```

### 후보 탐색

홀드아웃 후보 탐색:

```bash
pnpm --filter @fst/backtester dev \
  --candidate-sweep \
  --sweep-all \
  --timeframe 5m \
  --universe krw-top \
  --market-limit 10 \
  --min-markets 4 \
  --holdout-days 14 \
  --training-days 30 \
  --step-days 7
```

워크포워드 후보 탐색:

```bash
pnpm --filter @fst/backtester dev \
  --candidate-walk-forward \
  --sweep-all \
  --timeframe 5m \
  --universe krw-top \
  --market-limit 10 \
  --min-markets 4 \
  --holdout-days 14 \
  --training-days 30 \
  --step-days 7
```

주의:

- `--baseline-evaluate`는 기본적으로 결과를 DB 추천 테이블에 저장하지 않는다.
- 후보 탐색 결과는 `candidate-holdout-recommendation`, `candidate-walk-forward-recommendation`으로 저장되어 기존 추천 결과를 덮어쓰지 않는다.
