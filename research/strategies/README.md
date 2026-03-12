# strategies

자동매매 전략 구현 패키지다.

초기 전략 후보:

- 이동평균 교차
- 변동성 돌파
- RSI 평균회귀

모든 전략은 공통 인터페이스를 따르도록 구현한다.

현재 구현:

- 이동평균 교차 전략
- 변동성 돌파 전략
- RSI 평균회귀 전략

추가된 조합용 팩터:

- 이동평균: `SMA`, `EMA`
- 모멘텀: `momentum`, `ROC`, `price slope`
- 변동성: `ATR`, `historical volatility`, `range expansion`
- 거래량: `average volume`, `volume spike ratio`
- 평균회귀: `RSI`, `z-score`
- 레짐 판정: `trend_up`, `trend_down`, `range`, `volatile`
