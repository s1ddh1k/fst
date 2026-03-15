# strategies

자동매매 전략 구현 패키지다.

## 전략 유형

### Scored 전략 (실전 후보)

시그널과 conviction(확신도)을 함께 반환한다. 포지션 사이징과 리스크 관리를 지원한다.

| 전략 | 파라미터 수 | 논리 |
|------|-----------|------|
| **relative-momentum-pullback** | 4 | market risk-on + 유니버스 상대강도 + rolling quote-volume liquidity + 단기 눌림 후 EMA20 reclaim |
| **leader-pullback-state-machine** | 4 | leader filter + 최근 ATR pullback setup arm + reclaim/follow-through trigger |
| **relative-breakout-rotation** | 4 | leader rotation + highest-high breakout + EMA20/EMA50 trend alignment |
| **residual-reversion** | 4 | 레거시 호환용 scored alias, 기본 스윕 대상 아님 |

현재 비교 대상 scored 전략은 `relative-momentum-pullback`, `leader-pullback-state-machine`, `relative-breakout-rotation`이다.

- 의사결정 주기: `1h` 닫힌 바만 허용
- 진입: breadth/regime 양호, 유니버스 상위 상대강도, `close > EMA50`, `EMA20 > EMA50`, 최근 6 bars 눌림 확인, 최근 3 bars 안의 EMA20 reclaim, `RSI14 >= 50`
- 유동성 게이트: rolling quote volume 기반 `liquiditySpread >= 0`
- 청산: hard stop, ATR trailing stop, risk-off/trend 훼손, minimum hold 이후 soft exit

follow-up 전략 메모:

- `leader-pullback-state-machine`
  - exposed params: `strengthFloor`, `pullbackAtr`, `setupExpiryBars`, `trailAtrMult`
  - regime gate -> leader filter -> setup armed -> trigger 구조
  - 청산: failed reclaim, no-follow-through, rank decay, trailing stop
- `relative-breakout-rotation`
  - exposed params: `breakoutLookback`, `strengthFloor`, `maxExtensionAtr`, `trailAtrMult`
  - 진입: leader breakout + trend aligned + not too extended
  - 청산: `riskOff || trendBreak || trailStop`

conviction 계산:

- 각 전략이 진입/청산 조건의 강도를 0~1로 점수화
- conviction은 포지션 사이저의 입력으로 사용

### 레거시 전략 (기준선 비교용)

BUY/SELL/HOLD만 반환. 12개 전략, 파라미터 수 5~45개.

- `integrated-multi-factor`, `moving-average-cross`, `volatility-breakout`
- `rsi-mean-reversion`, `volume-filtered-breakout`, `regime-filtered-moving-average-cross`
- `template-breakout-trend-volume`, `template-mean-reversion-bands`
- `zscore-rsi-reversion`, `zscore-rsi-reversion-guarded`
- `zscore-rsi-uptrend-reversion`, `zscore-rsi-trend-pullback`

## 포지션 사이징

`PositionSizer` 인터페이스로 비중을 결정한다.

- **volatility-target** — `targetWeight = min(maxWeight, targetVol / currentVol * conviction)`
- **fixed-weight** — 고정 비중 × conviction

## 포트폴리오 리스크

`PortfolioRiskManager` 인터페이스로 포트폴리오 수준 리스크를 제어한다.

- **drawdown-circuit-breaker** — warn 5% → 신규 진입 차단, kill 10% → 전 포지션 청산, cooldown 48 bars

## 팩터 라이브러리

모든 전략이 공유하는 팩터 함수:

- 이동평균: `SMA`, `EMA`
- 모멘텀: `momentum`, `ROC`, `price slope`
- 변동성: `ATR`, `historical volatility`, `range expansion`
- 거래량: `average volume`, `volume spike ratio`, `OBV`, `OBV slope`
- 평균회귀: `RSI`, `z-score`
- 밴드/오실레이터: `Bollinger Bands`, `stochastic`, `CCI`
- 추세: `MACD`, `ADX`, `Donchian channel`
- 레짐: `trend_up`, `trend_down`, `range`, `volatile`

## 구조

```
src/
  types.ts                    # Strategy, ScoredStrategy, PositionSizer, PortfolioRiskManager
  index.ts                    # 전체 export
  factors/                    # 팩터 라이브러리
  relative-momentum-pullback.ts # scored: 기본 relative momentum pullback
  leader-pullback-state-machine.ts # scored: leader setup/trigger state machine
  relative-breakout-rotation.ts # scored: breakout rotation 대체안
  residual-reversion-strategy.ts # scored: 레거시 호환
  market-state.ts             # breadth / relative strength / liquidity context
  position-sizer.ts           # 포지션 사이징
  portfolio-risk.ts           # 포트폴리오 리스크
  integrated-multi-factor.ts  # 레거시: 통합 멀티 팩터
  ...                         # 기타 레거시 전략
```
