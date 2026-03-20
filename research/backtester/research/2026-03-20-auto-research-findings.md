# Auto-Research 결과 보고서 (2026-03-20)

## 요약

block stage auto-research 파이프라인의 구조적 버그 5건 수정 후, 볼린저 밴드 mean reversion 전략을 새로 구현하여 **3개 전략이 net 흑자 달성**.

## 수정된 버그

1. **이중 regime 필터링**: leader/pullback 전략이 `withRegimeGate()` + 내부 regime 체크로 이중 필터링 → 내부 제거
2. **AND 조건 과다**: leader trigger 4개 AND, pullback 9개 AND → 핵심 조건만 hard gate, 나머지 conviction 보너스로 전환
3. **Reversion exit stuck**: 포지션이 영원히 열려있는 문제 → time-decay exit threshold + profit-taking 추가
4. **Rotation 과잉 매도**: `compositeMomentumSpread < 0`이 15m에서 매 바마다 플립 → 제거 (turnover 571→277)
5. **1h→5m execution candle 시간 범위 불일치**: 1h 캔들 1685일 vs 5m 캔들 396일 → WF 윈도우 전체에서 `no_execution_window` 100% 차단 → reference candle을 execution 데이터 범위로 클리핑

## 추가 개선

- **수수료 현실화**: 0.05% → 0.025% (업비트 쿠폰 적용 기준)
- **StrategyAdapter reason 패스스루**: 디버깅용 실제 reject 사유 전달
- **포지션 사이징**: `equity / maxOpenPositions * conviction` 공식으로 자본 활용률 개선

## 전략별 결과 (20 마켓, WF 6윈도우, 90일/윈도우)

### BB 볼린저 밴드 Mean Reversion (주간형) — 신규

| 지표 | 값 |
|---|---|
| net return | **+0.71%** (90일 평균) |
| gross return | +1.01% |
| win rate | **49.4~59.5%** |
| positive windows | **4/6** |
| trades/window | 17~23 |
| worst window | -1.59% |
| best window | +3.29% |

**최적 파라미터**: bbWindow=336~504 (14~21일 SMA), bbMultiplier=2.8~3.5, rsiPeriod=120~168, exitRsi=48~51, stopLossPct=25~30%, maxHoldBars=504~672, entryPercentB=-0.08~-0.20

레짐 적응형 exit: 상승장 exitRsi+10, 하락장 exitRsi-10, 횡보장 exitRsi-5

### Leader 1h Pullback — 기존 개선

| 지표 | 값 |
|---|---|
| net return | **+0.88%** (90일 평균) |
| gross return | +1.56% |
| win rate | 27.7% |
| positive windows | **4/6** |
| trades/window | 40 |
| worst window | -0.72% |
| best window | +4.39% |

exit 로직 개선: `failedReclaim`/`noFollowThrough` 제거, trailing stop 중심으로 전환.

### Residual Reversion 1h — 기존 개선

| 지표 | 값 |
|---|---|
| net return | **+0.68%** (90일 평균) |
| gross return | +0.74% |
| win rate | 34.7% |
| positive windows | 2/6 |
| trades/window | 4.5 |
| worst window | -0.93% |
| best window | +4.19% |

### 실패 전략

- **Rotation 15m**: net -1.3%, 0/4 윈도우 — 신호 자체가 역방향
- **Pullback 1h**: net -0.05%, 2/6 윈도우 — 손익분기 근처
- **BB 일간형**: net -3.3~-6.6% — 과다 트레이드

## 연간 수익률 추정

| 전략 | 90일 net | 연간 추정 | 100만원 기준 |
|---|---|---|---|
| Leader 1h | +0.88% | ~3.5% | 103.5만원 |
| BB 주간형 | +0.71% | ~2.8% | 102.8만원 |
| Reversion | +0.68% | ~2.7% | 102.7만원 |

Best window 기준: Leader 연 17.6%, BB 연 12.4%

## 핵심 교훈

1. **사람의 직관이 핵심**: LLM이 8 iteration 못 찾은 edge를 사용자의 BB 하단 매수 아이디어가 단번에 발견
2. **비용이 전부**: 기존 전략들의 gross edge는 양수였으나 비용이 초과. 수수료 현실화 + 저빈도 전략이 해법
3. **마켓 수가 중요**: 7마켓→20마켓 확대 시 Leader가 -0.15%→+0.88%로 흑자 전환
4. **auto-research는 파라미터 최적화에 강하고, 새 전략 아키텍처 발명에 약함**
