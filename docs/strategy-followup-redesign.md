# 전략 2차 진단 및 재설계 지시서

이 문서는 현재 업비트 KRW 현물 자동매매 저장소의 `relative-momentum-pullback` 전략이 **구현은 되었지만 OOS에서 잘 작동하지 않는 상태**를 전제로, 다음 단계 구현 방향을 Codex에게 명확히 전달하기 위한 후속 설계 문서다.

이번 문서의 목적은 단순 파라미터 재탐색이 아니라,

1. **문제의 본질이 무엇인지 합의하고**
2. **지금 구조를 유지한 최소 수정안**과
3. **전략 철학 자체를 바꾸는 대체안**을
4. **같은 검증 프레임워크에서 비교 구현**하게 만드는 것이다.

---

# 1. 현재 관측 결과 요약

다음 수치는 이미 구현된 버전의 최근 결과로 간주한다.

## Holdout 30d / 1h / krw-top / top 10 / 54-grid
- best net return: `+0.0846%`
- best gross return: `+0.1856%` 수준에서 소폭 하향
- tradeCount: `2`
- turnover: `0.5008`
- top cluster: `minStrengthPct=0.7`, `pullbackZ=0.9 or 1.2`
- `trailAtrMult=1.8/2.2`가 `2.6`보다 낫기 시작함
- save-regime 기준 `bootstrapPassRate=0`, `randomPassRate=0`

## Walk-forward / 1h / training 90d / holdout 30d / step 14d / 54-grid
- top avgTestReturn: `-0.1266%`
- avgTestTradeCount: `0.67`
- avgTurnover: `0.1654`
- `bootstrapPassRate=0`, `randomPassRate=0`

---

# 2. 핵심 결론

## 2.1 본질적인 문제는 exit보다 **entry 희소성 + entry 지연**이다

현재 결과에서 가장 먼저 보이는 문제는 수익률 자체보다 **샘플 부족**이다.

- holdout 최고 성과가 양수이더라도 거래가 2회뿐이면 의미가 약하다.
- walk-forward 평균 거래 수가 0.67이면 fold 대부분이 사실상 "거래가 없는 전략"에 가깝다.
- `trailAtrMult`를 좁힌 쪽이 더 나아지기 시작한 것은, 진입 이후 충분히 달리는 구간보다 **늦게 들어가서 초반 이익을 잘 못 먹고 있다는 신호**로 해석하는 것이 자연스럽다.
- `minStrengthPct=0.7` 쪽이 상대적으로 낫다는 점도, 현재 하드게이트 조합이 지나치게 엄격해서 기회를 잘라내고 있음을 시사한다.

따라서 현 단계에서 우선순위는 다음과 같다.

1. **entry 구조를 고친다**
2. 그 다음에 exit를 다듬는다
3. 지금 상태에서는 exit만 손봐서는 해결되지 않는다

---

## 2.2 현재 전략은 overtrade의 반작용으로 undertrade 상태가 되었다

이 저장소는 원래 residual-reversion 계열에서 거래가 너무 많아 비용을 이기지 못했고, 이후 구조를 tighten 하면서 `relative-momentum-pullback`로 넘어왔다.

하지만 현재 구현은 아래 조건을 사실상 모두 하드게이트처럼 겹쳐 쓰고 있다.

- 시장 risk-on
- 유니버스 상대강도 상위
- 유동성/거래량 확인
- pullback 발생
- EMA20 reclaim 확인

이 구조는 의도는 좋아도 실제로는 **희귀한 이벤트만 기다리는 gate stack**이 된다.
롱 전용 / 단일 포지션 / 1시간봉에서는 “모든 조건이 완벽한 rare event”를 찾기보다,
**리더를 고르고, setup을 arm 하고, trigger에서 진입하는 state machine** 구조가 더 적합하다.

---

## 2.3 이 전략은 한 번 더 구조 수정할 가치가 있지만, 실패하면 다른 알파로 갈아타야 한다

`relative-momentum-pullback`의 아이디어 자체는 완전히 틀리지 않았다.
즉,

- 시장이 괜찮고
- 유니버스에서 강한 코인을 고른 뒤
- 눌림 후 재가속 구간을 잡는다

는 철학은 여전히 유효하다.

하지만 현재 구현 방식은 너무 늦고 너무 희소하다.
따라서 이 전략은 **딱 한 번 더 구조적으로 수정**해 볼 가치는 있다.
다만 그 수정 후에도 trade sufficiency와 OOS 성능이 회복되지 않으면,
**1h long-only single-position 기준으로는 다른 alpha 구조로 갈아타는 것**이 맞다.

---

# 3. Codex가 바로 구현해야 할 우선순위

## Task A. Ghost trade study를 먼저 구현

파라미터를 더 돌리기 전에, 현재 entry 자체에 edge가 있는지부터 분해해야 한다.

다음 분석 모듈을 추가한다.

### 목적
실제 진입 신호가 발생한 모든 시점에 대해,
실거래 체결 여부와 상관없이 이후 구간의 잠재 수익/손실 분포를 측정한다.

### 필수 산출값
각 entry signal 시점마다 아래를 기록한다.

- market
- timestamp
- conviction
- entry reference price (next-bar open 또는 simulator의 reference fill price)
- 이후 6 / 12 / 24 bar 기준
  - MFE
  - MAE
  - gross return
  - net return after round-trip fee assumption

### 해석 기준
- `median(net MFE after cost)`가 0 이하이면 **entry 자체가 약한 것**으로 본다.
- MFE는 충분한데 realized return만 낮으면 **exit 또는 execution 문제**로 본다.
- trade count가 너무 적어도 ghost signal count가 충분하면, **gate를 완화해야 한다**는 의미다.

이 모듈은 이후 모든 전략 비교에 재사용 가능해야 한다.

---

## Task B. 최소 수정안: leader-pullback state machine으로 rewrite

현재 `relative-momentum-pullback`를 완전히 버리지는 말고,
다음 구조로 바꾼 버전을 새 전략 구현체로 추가한다.

전략 이름 예시:
- `leader-pullback-state-machine`
- 또는 기존 전략을 교체해도 되지만, 비교를 위해 새 이름으로 두는 것을 권장한다.

---

# 4. 최소 수정안 설계

## 4.1 exposed params는 4개만 유지

아래 4개만 외부 탐색 대상으로 둔다.

- `strengthFloor`
- `pullbackAtr`
- `setupExpiryBars`
- `trailAtrMult`

기존 `pullbackZ`는 제거하고 **ATR 기준 pullback 깊이**로 바꾼다.
이유는 1시간봉 long-only 환경에서는 Z-score보다 ATR 기반 깊이가 entry timing과 risk sizing에 더 직접적이기 때문이다.

---

## 4.2 남길 지표 / 버릴 지표

### 남길 지표
- `momentumPercentile`
- `returnPercentile`
- `compositeMomentumSpread`
- `riskOnScore`
- `aboveTrendRatio`
- `EMA20`
- `EMA50`
- `ATR`

### 유지하되 역할 축소
- `RSI`: 있더라도 soft confirm 수준
- `liquiditySpread`: hard gate가 아니라 ranking 또는 cost penalty용
- `volume spike`: hard gate에서 제거
- `zScore`: directional alpha가 아니라 과열/눌림 보조 용도만 허용

---

## 4.3 전략 상태 구조

이 전략은 다음 4단계 개념을 가져야 한다.

1. **regime gate**
2. **leader filter**
3. **setup armed**
4. **trigger / entry**

즉, 기존처럼 모든 조건을 같은 시점에 동시에 만족해야 BUY가 아니라,
"강한 종목이 최근 눌렸고, 아직 setup이 살아 있으며, 지금 재가속 trigger가 발생했다"로 바꾼다.

---

## 4.4 regime gate

다음 조건은 하드게이트로 유지한다.

```ts
regimeGood =
  trendScore > 0 &&
  aboveTrendRatio >= 0.55 &&
  close > ema50 &&
  ema20 > ema50 &&
  ema20Slope > 0;
```

구현 주의:
- `ema20Slope`는 단순 `ema20 > ema20Prev` 또는 최근 3 bars 기준 상승으로 충분하다.
- `close > ema50`와 `ema20 > ema50`는 큰 추세가 위인지 확인하는 필터다.
- 이 조건은 너무 완화하지 말 것. 이 전략의 핵심은 long-only 환경에서 추세 하방 구간을 최대한 피하는 것이다.

---

## 4.5 leader filter

```ts
leader =
  momentumPercentile >= strengthFloor &&
  returnPercentile >= 0.50 &&
  compositeMomentumSpread > 0;
```

해석:
- 후보는 유니버스 상위 강한 종목만 남긴다.
- `strengthFloor`는 기존 `minStrengthPct`의 대체 개념이다.
- `returnPercentile`은 너무 약한 종목을 제거하는 보조 필터다.

---

## 4.6 setup armed

최근 `setupExpiryBars` 안에 눌림이 있었는지를 확인한다.

```ts
armed =
  recentMinDistanceToEma20Atr <= -pullbackAtr &&
  recentMinCloseVsEma50 > -0.01;
```

설명:
- `recentMinDistanceToEma20Atr`는 최근 N bars 안에서 `(close - ema20) / atr`의 최소값
- 즉, EMA20 아래로 의미 있는 눌림이 있었는지 확인한다.
- `recentMinCloseVsEma50 > -0.01`은 눌림 중에도 EMA50을 크게 훼손하지 않았는지 보는 가드다.
- setup은 영원히 유효하면 안 되므로 `setupExpiryBars` 안에서만 인정한다.

---

## 4.7 trigger

진입 trigger는 단순 EMA20 reclaim보다 **재가속 확인**에 가깝게 바꾼다.

```ts
trigger =
  close > ema20 &&
  close > Math.max(prevHigh, prev2High) &&
  closePositionInBar >= 0.60 &&
  (close - ema20) <= 0.8 * atr;
```

해석:
- `close > ema20`: reclaim
- `close > max(prevHigh, prev2High)`: follow-through 확인
- `closePositionInBar >= 0.60`: 캔들 상단부 마감으로 힘을 확인
- `(close - ema20) <= 0.8 * atr`: 너무 멀리 달아난 늦은 진입 방지

### 최종 진입 조건

```ts
BUY = flat && regimeGood && leader && armed && trigger;
```

---

## 4.8 exit rewrite

청산은 세 단계로 나눈다.

1. **초기 failed reclaim fast exit**
2. **중간 추세 유지 / 랭크 악화 exit**
3. **후반 ATR trailing stop**

### 예시 로직

```ts
riskOff =
  trendScore < -0.10 || riskOnScore < -0.05;

failedReclaim =
  barsHeld <= 2 && close < ema20;

noFollowThrough =
  barsHeld >= 3 && highestSinceEntry < entryPrice + 0.5 * atr;

rankDecay =
  close < ema20 &&
  momentumPercentile < 0.45 &&
  compositeMomentumSpread < 0;

trailStop =
  close <= highestSinceEntry - trailAtrMult * atr;

SELL =
  riskOff ||
  failedReclaim ||
  noFollowThrough ||
  rankDecay ||
  trailStop;
```

핵심은 다음이다.
- 진입 직후 다시 EMA20 아래로 밀리면 바로 실패로 본다.
- 일정 bars 동안 전혀 follow-through가 없으면 잘못 진입한 것으로 본다.
- 초반만 넘기면 가능한 한 추세를 타게 두고, 최종적으로 trailing stop이 수익 보호를 담당한다.

---

## 4.9 추천 탐색 그리드

```ts
strengthFloor:   [0.60, 0.70, 0.80]
pullbackAtr:     [0.5, 0.9, 1.3]
setupExpiryBars: [2, 4, 6]
trailAtrMult:    [1.8, 2.2, 2.6]
```

이 그리드의 목표는 단기 수익 극대화가 아니라,
먼저 **OOS trade count를 정상 수준으로 복구**하는 것이다.

---

# 5. 대체안 설계: relative-breakout-rotation

최소 수정안과 별도로, 전략 철학 자체를 바꾼 대체안을 구현해서 비교해야 한다.

이 환경에서는 사실 breakout/rotation 계열이 더 잘 맞을 가능성이 높다.

전략 이름 예시:
- `relative-breakout-rotation`

---

## 5.1 왜 이 대체안이 필요한가

1시간봉 / 롱 전용 / 단일 포지션에서는
"강한 리더를 뽑아 추세 지속 구간을 먹는 것"이 훨씬 자연스럽다.

pullback-reclaim는 진입이 늦어질 수 있고, 확인 조건을 늘릴수록 희소해진다.
반면 breakout-rotation은 다음 장점이 있다.

- 이벤트가 더 자주 나온다.
- single-position에서 가장 강한 리더를 선택하기 쉽다.
- volume/liquidity를 alpha가 아니라 execution penalty로 밀어내기 쉽다.
- trend persistence를 활용하기 좋다.

---

## 5.2 exposed params

아래 4개만 외부 노출한다.

- `breakoutLookback`
- `strengthFloor`
- `maxExtensionAtr`
- `trailAtrMult`

---

## 5.3 entry

```ts
regimeGood =
  trendScore > 0 &&
  aboveTrendRatio >= 0.55;

leader =
  momentumPercentile >= strengthFloor &&
  compositeMomentumSpread > 0;

breakout =
  close > highestHigh(breakoutLookback);

trendAligned =
  close > ema20 &&
  ema20 > ema50;

notTooExtended =
  (close - ema20) <= maxExtensionAtr * atr;

BUY = flat && regimeGood && leader && breakout && trendAligned && notTooExtended;
```

---

## 5.4 exit

```ts
riskOff =
  trendScore < -0.10 || riskOnScore < -0.05;

trendBreak =
  close < ema20 && momentumPercentile < 0.50;

trailStop =
  close <= highestSinceEntry - trailAtrMult * atr;

SELL = riskOff || trendBreak || trailStop;
```

---

## 5.5 추천 탐색 그리드

```ts
breakoutLookback: [10, 20, 30]
strengthFloor:    [0.60, 0.70, 0.80]
maxExtensionAtr:  [0.8, 1.2, 1.6]
trailAtrMult:     [1.8, 2.2, 2.6]
```

---

# 6. 검증 및 승격 규칙

현재처럼 거래 수가 거의 없는 상태에서는 단순 수익률 숫자가 의미가 없다.
따라서 승격 규칙을 **빈도 충분성 → 성능 → 강건성** 순서로 바꾼다.

## 6.1 trade sufficiency rule

전략이 아무리 양수라도 아래를 먼저 통과해야 한다.

- 전체 walk-forward OOS executed trades `>= 25`
- 가능하면 `>= 40`
- 30일 fold당 평균 tradeCount `1.5 ~ 6`
- 한두 거래가 전체 PnL 대부분을 만들면 탈락

## 6.2 performance rule

- `avgTestReturn > 0`
- `medianTestReturn > 0`
- average turnover가 과도하지 않을 것
- 거래 비용 차감 후에도 양수일 것

## 6.3 robustness rule

- `bootstrapPassRate >= 0.60`
- `randomPassRate >= 0.60`
- 상위 파라미터 이웃 조합이 비슷하게 살아남을 것
- 특정 한 조합만 튀는 경우 탈락

현재 결과는 **성능 탈락 이전에 빈도 탈락** 상태로 간주한다.

---

# 7. Codex에게 요구하는 구현 산출물

## 필수 구현

1. ghost trade study 모듈 추가
2. `leader-pullback-state-machine` 전략 구현
3. `relative-breakout-rotation` 전략 구현
4. 두 전략 모두 동일한 walk-forward 파이프라인에 연결
5. 기존 전략과 동일 조건으로 비교 가능하도록 report 확장

## 필수 리포트 항목

전략별 / 파라미터별 / fold별로 최소 아래를 출력한다.

- avgTrainReturn
- avgTestReturn
- medianTestReturn
- executedTradeCount
- signalCount
- ghostSignalCount
- avgTurnover
- grossReturn
- netReturn
- feePaid
- slippagePaid
- bootstrapPassRate
- randomPassRate

## 필수 비교 결론

최종 리포트는 아래 질문에 반드시 답해야 한다.

1. 현재 전략의 문제는 entry 자체인가, exit인가?
2. 최소 수정안에서 trade count가 정상 수준으로 회복되었는가?
3. 대체안이 최소 수정안보다 OOS에서 더 나은가?
4. production 후보로 남길 전략은 무엇인가?

---

# 8. 구현 시 금지사항

- 단순히 기존 파라미터만 더 촘촘히 탐색하지 말 것
- same-bar fill을 다시 허용하지 말 것
- point-in-time universe 제약을 깨지 말 것
- execution / fee / tick / min-order 제약을 전략 코드로 다시 끌고 오지 말 것
- signal이 너무 적은데 단지 수익률 숫자가 좋다고 승격하지 말 것

---

# 9. 권장 작업 순서

1. ghost trade study 추가
2. 최소 수정안 구현
3. 대체안 구현
4. 동일 walk-forward로 비교
5. trade sufficiency rule 먼저 확인
6. 그 다음 performance / robustness 비교
7. 채택 또는 폐기 결론 문서화

---

# 10. Codex에게 주는 최종 지시

이 작업은 "현재 전략을 조금 더 튜닝"하는 작업이 아니다.

핵심은 다음 둘 중 하나를 확인하는 것이다.

1. `relative-momentum-pullback` 계열을 state machine 구조로 바꾸면 살아나는가?
2. 아니면 1시간봉 long-only single-position 환경에서는 breakout/rotation 계열로 갈아타는 것이 맞는가?

따라서 분석만 하지 말고,
- 코드 구현,
- 테스트 추가,
- 비교 리포트 생성,
- 최종 채택안 제시
까지 완료해야 한다.
