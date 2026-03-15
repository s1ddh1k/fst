# AGENTS.md

## 작업 목적

이 저장소의 업비트 KRW 현물 자동매매 시스템을 **전략만 미세조정하는 수준이 아니라 구조적으로 재설계**한다.
현재 `residual-reversion` 전략은 폐기 대상에 가깝다. 이 작업의 목표는 다음 두 가지다.

1. **수수료/슬리피지를 감안해도 살아남을 수 있는 전략 구조**로 바꾸는 것
2. **새 전략을 실제로 검증할 수 있는 백테스트/포트폴리오/체결 구조**로 바꾸는 것

이번 작업에서는 분석만 하지 말고 **실제 코드 수정**까지 수행한다.

---

## 현재 설계의 핵심 결함

### 1) 전략 정의 자체가 잘못됨
현재 `residual-reversion`은 진짜 residual 전략이 아니다.
`zScoreSpread = coin z-score - universe average z-score`는 회귀 잔차가 아니라 단순한 상대 강약도다.
롱 전용 현물에서 "유니버스 대비 약한 코인"을 반복 매수하면 약한 종목을 들고 있을 가능성이 높다.

### 2) 평균회귀 + 모멘텀을 애매하게 섞어 turnover만 커짐
현재 구조는 약한 종목의 짧은 반등을 자주 매수하고 빨리 청산하는 형태라서, 5분봉에서는 비용을 이기기 어렵다.

### 3) 단일 포지션 제약과 종목별 독립 신호 구조가 충돌함
현재는 각 종목이 독립적으로 BUY/SELL/HOLD를 내지만 실제 제약은 **동시에 1개 종목만 보유 가능**하다.
따라서 전략 신호와 별도로 **유니버스 전체 후보 중 하나를 고르는 포트폴리오 코디네이터**가 반드시 필요하다.

### 4) 데이터 축 정규화가 필요함
업비트 분봉은 체결이 있을 때만 생성될 수 있으므로, 종목별로 누락된 바가 있으면 lookback 기반 인디케이터가 왜곡된다.
모든 마켓을 **full time grid**로 재정렬하고, 누락된 바는 synthetic candle로 채워야 한다.

### 5) 실행 모델이 전략과 분리되어야 함
전략은 신호만 내고, 체결/수수료/슬리피지/최소주문금액/호가단위는 **체결 시뮬레이터 + 거래소 어댑터**가 책임져야 한다.

---

## 이번 작업에서 반드시 지킬 원칙

- TypeScript 유지
- 거래소는 업비트 KRW 현물 기준
- **롱 전용**
- **단일 포지션만 허용**
- 전략 인터페이스는 `ScoredStrategy` 유지
- 전략은 `BUY | SELL | HOLD` 와 `conviction`만 반환
- 포지션 사이징은 외부 모듈이 담당
- **백테스트에서 same-bar fill 금지**
- **lookahead 금지**
- 유니버스 선정은 반드시 **point-in-time**
- 수수료/체결규칙/호가단위/최소주문금액은 전략 코드에 하드코딩하지 말 것

---

## 목표 아키텍처

다음 4계층으로 분리한다.

1. **Data / Universe Layer**
   - 원시 캔들 수집
   - full bar grid 정규화
   - point-in-time 유니버스 생성
   - 거래소 제약(최소주문금액, tick size, 수수료, 주문 타입) 제공

2. **Alpha Layer**
   - `ScoredStrategy` 구현체
   - 현재 기본 전략은 `relative-momentum-pullback`
   - 의사결정은 1시간봉 기준
   - 5분봉은 추후 execution assist 용도로만 사용 가능하게 설계

3. **Portfolio Layer**
   - 유니버스 전체의 BUY 후보를 평가해 **한 종목만 선택**
   - 단일 포지션, cooldown, 진입 억제, 교체 금지/허용 정책 관리

4. **Execution Layer**
   - next-bar 기반 체결 시뮬레이션
   - 수수료/슬리피지/호가단위/최소주문금액 반영
   - 전략 신호와 체결 규칙을 분리

---

## 기본 전략 교체: relative-momentum-pullback

현재 전략 대신 아래 구조를 기본 전략으로 구현한다.

### 전략 철학
- 롱 전용 현물에서는 **강한 코인의 추세 내 눌림목 매수**가 구조적으로 더 적합하다.
- 따라서 "상대적으로 약한 코인을 사서 평균회귀를 기다리는 구조" 대신,
  **시장 risk-on + 강한 코인 + 단기 눌림 후 회복** 구조로 바꾼다.

### 진입 개념
아래 조건을 모두 만족할 때만 BUY 후보를 만든다.

1. **시장 레짐 양호**
   - `composite.regime`이 `trend_down` 또는 `volatile`이면 진입 금지
   - `trendScore > 0`
   - `riskOnScore >= minRiskOn`
   - `aboveTrendRatio >= 0.55`

2. **유니버스 내 강한 코인**
   - `momentumPercentile >= minStrengthPct`
   - `returnPercentile >= 0.55`
   - `compositeMomentumSpread > 0`
   - `liquiditySpread >= 0`

3. **큰 추세가 살아 있음**
   - `close > EMA50`
   - `EMA20 > EMA50`

4. **최근 눌림이 실제로 있었고 회복 신호가 확인됨**
   - 최근 6 bars 중 최소 `z20 <= -pullbackZ`
   - 직전 종가가 `EMA20` 아래였고 현재 종가가 `EMA20` 위로 회복
   - `RSI14 >= 50`
   - `z20 < 1.0`

5. **거래량/유동성 확인**
   - `volumeSpikeRatio >= 0.9`

### 청산 개념
보유 중에는 "평균 복귀했으니 바로 청산"이 아니라, **추세 훼손 시 청산**으로 바꾼다.

SELL 조건 예시:
- `riskOnScore` 급격한 악화
- `trendScore < -0.10`
- hard stop hit
- ATR trailing stop hit
- `close < EMA20 && compositeMomentumSpread < 0 && momentumPercentile < 0.50`
- 오래 보유했는데 고점 대비 재하락

### 기본 파라미터
아래 4개만 노출한다.

- `minStrengthPct` 기본값 `0.75`
- `minRiskOn` 기본값 `0.10`
- `pullbackZ` 기본값 `0.90`
- `trailAtrMult` 기본값 `2.2`

### 추천 탐색 그리드
- `minStrengthPct`: `[0.70, 0.80, 0.90]`
- `minRiskOn`: `[0.05, 0.15]`
- `pullbackZ`: `[0.6, 0.9, 1.2]`
- `trailAtrMult`: `[1.8, 2.2, 2.6]`

총 54 조합을 기본 그리드로 사용한다.

---

## 데이터 정규화 요구사항

### full bar grid 정규화
모든 마켓 캔들은 동일한 타임 인덱스를 가져야 한다.
누락된 바는 synthetic candle로 채운다.

synthetic candle 규칙:
- `open = prevClose`
- `high = prevClose`
- `low = prevClose`
- `close = prevClose`
- `volume = 0`
- `quoteVolume = 0` (필드가 있으면)
- `isSynthetic = true` 플래그 추가 가능

### point-in-time 유니버스
현재/최신 기준 top cap 유니버스를 고정 사용하지 말고,
**최근 N일/시간의 거래대금 기준 rolling top-N** 유니버스를 point-in-time으로 구성한다.

기본값 제안:
- decision timeframe: 1h
- universe refresh cadence: 하루 1회 또는 4시간 1회
- selection metric: 최근 30일 KRW quote volume / trading value
- N: 10~15

---

## 포트폴리오 코디네이터 필수 구현

반드시 별도 모듈로 구현한다.
자세한 요구사항은 `docs/portfolio-execution-design.md`를 따른다.

핵심 책임:
- 유니버스 전체 전략 결과 취합
- BUY 후보 중 **최고 conviction 1개 선택**
- 단일 포지션 제약 강제
- 손절 후 cooldown 적용
- 같은 종목 즉시 재진입 방지
- 하루 최대 거래 수 등 선택적 가드레일 지원

기본 방침:
- 보유 포지션이 있으면 해당 종목의 SELL/HOLD만 처리
- 신규 BUY는 flat 상태에서만 가능
- switch trade(기존 보유 종목 강제 청산 후 다른 종목 갈아타기)는 v1에서는 비활성화

---

## 체결 시뮬레이터 필수 구현

반드시 별도 모듈로 구현한다.
자세한 요구사항은 `docs/portfolio-execution-design.md`를 따른다.

v1 목표:
- same-bar fill 금지
- next-bar execution
- 업비트 제약 반영
- 수수료 반영
- tick size rounding
- 최소 주문 금액 반영
- 보수적 slippage/impact 반영

v1에서는 order book replay까지 가지 않아도 된다.
그러나 **나중에 order-book 기반 fill model을 끼워 넣을 수 있는 인터페이스**로 설계해야 한다.

---

## 구현 산출물

아래 산출물이 필요하다.

1. `residual-reversion`을 대체할 새 기본 전략 구현
2. 포트폴리오 코디네이터 구현
3. 체결 시뮬레이터 구현
4. 데이터 정규화(full grid + synthetic candle) 구현
5. point-in-time 유니버스 선택 로직 구현
6. 백테스트 엔진을 위 구조에 맞게 연결
7. 테스트 추가
8. 문서 업데이트

가능하면 아래와 비슷한 구조를 선호한다. 파일명은 저장소 구조에 맞춰 조정 가능하다.

```text
src/
  strategies/
    relativeMomentumPullback.ts
  portfolio/
    PortfolioCoordinator.ts
    portfolioTypes.ts
  execution/
    ExecutionSimulator.ts
    executionTypes.ts
    exchangeAdapter.ts
  universe/
    universeSelector.ts
    candleNormalizer.ts
  backtest/
    BacktestEngine.ts
    backtestTypes.ts
test/
  strategies/
  portfolio/
  execution/
  universe/
  integration/
```

---

## 테스트/검증 요구사항

반드시 자동화 테스트를 추가한다.

### 단위 테스트
- synthetic candle 생성이 올바른지
- point-in-time 유니버스에 lookahead가 없는지
- strategy가 `BUY/SELL/HOLD`와 `conviction`을 안정적으로 반환하는지
- coordinator가 BUY 후보 중 하나만 선택하는지
- cooldown이 작동하는지
- simulator가 same-bar fill을 허용하지 않는지
- tick size 및 최소 주문 금액을 지키는지

### 통합 테스트
- flat → buy → hold → sell 흐름이 단일 포지션 규칙을 지키는지
- 백테스트 전체 루프에서 strategy / coordinator / simulator 연결이 정상인지
- loss exit 직후 재진입 방지 로직이 동작하는지

### 회귀 방지 체크
- 기존보다 trade count가 과도하게 증가하지 않는지
- 5m 알파 직접 최적화를 피하고 1h 결정 구조가 유지되는지
- 거래 비용 반영 후에도 gross edge가 없는 과잉매매가 발생하지 않는지

---

## 비기능 요구사항

- 타입 안전성 유지
- 기존 public interface는 불필요하게 깨지 말 것
- 로깅/디버깅이 가능해야 함
- 백테스트 결과에서 다음 지표를 쉽게 확인할 수 있게 할 것
  - gross return
  - net return
  - turnover
  - win rate
  - avg hold bars
  - max drawdown
  - fee paid
  - slippage paid
  - rejected orders count
  - cooldown skips count

---

## 구현 순서

아래 순서대로 진행한다.

1. 현재 백테스트 엔진과 전략 연결 지점 파악
2. 캔들 정규화와 point-in-time 유니버스부터 구현
3. `relative-momentum-pullback` 전략 구현
4. 포트폴리오 코디네이터 구현
5. 체결 시뮬레이터 구현
6. 백테스트 엔진 배선 변경
7. 테스트 추가
8. 결과 로그/리포트 개선

---

## 중요한 금지사항

- 현재 `residual-reversion` 파라미터만 만지작거리며 작업을 끝내지 말 것
- strategy 안에 fee/tick/min order/hardcoded exchange rules를 섞지 말 것
- same-bar close fill을 허용하지 말 것
- 현재 시점의 유니버스 구성으로 과거 전체를 돌리는 lookahead를 넣지 말 것
- 단일 포지션 제약을 무시한 채 종목별 독립 BUY를 허용하지 말 것
- 5분봉 고빈도 진입 전략을 기본 전략으로 채택하지 말 것

---

## 추가 메모

향후 평균회귀 전략을 다시 도입하려면 `range-only residual module`로 분리하고,
최소한 아래 팩터가 추가돼야 한다.

- `betaToComposite`
- `residualReturn = coinReturn - beta * compositeReturn`
- `residualPriceZ`
- `residualHalfLife`

하지만 이번 작업의 우선순위는 아니다.
이번 작업에서는 **구조적으로 더 자연스러운 롱 전용 relative momentum pullback 시스템**을 먼저 완성한다.

---

## 최종 완료 기준

작업 완료로 간주되려면 아래를 모두 만족해야 한다.

- 코드가 빌드/테스트 통과
- 새 전략, coordinator, simulator가 실제로 연결됨
- same-bar fill 제거
- full grid normalization 적용
- point-in-time universe 적용
- 문서화 완료
- 기본 백테스트를 재실행할 수 있음
- 결과를 검토할 수 있는 로그/리포트가 남음

