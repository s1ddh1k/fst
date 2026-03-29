# Regime System 재설계

## 현재 문제

market-state.ts(1300줄)의 composite regime이 크립토에 안 맞음:
- 3개 anchor(weekly/daily/intraday)를 합산하면서 "volatile"이 93% 차지
- breadth(aboveTrendRatio)가 SMA(55) 기반 → 너무 짧아서 노이즈
- adaptive regime을 추가해도 composite 합산에서 volatile이 압도
- rotation 전략이 3 trades/window밖에 못 냄

## 새 설계: 2-Layer Regime System

### Layer 1: Macro Regime (거시)

**BTC 1h 캔들만 사용** — 전체 시장 방향 대표.

```typescript
type MacroRegime = "bull" | "bear" | "neutral";

function detectMacroRegime(btcCandles: Candle[], index: number): MacroRegime {
  // 검증 완료된 adaptive scoring (regime-switching-backtest.ts에서 6yr +672%)
  // SMA(50) vs SMA(200) 구조
  // OBV divergence (2주)
  // 월간 모멘텀
  // 캔들 구조 (꼬리 비율)
  // ATR 가속도
  // score ≥ 4 → bull, ≤ -2 → bear, else neutral
  // cooldown: 72 bars
}
```

- **업데이트**: 매 1h bar
- **"volatile" 없음** — 크립토는 항상 volatile, 의미 없는 분류
- **BTC 전용** — 개별 코인 regime 계산 안 함 (시장 전체 방향만)

### Layer 2: Micro Condition (미시)

**개별 코인 상태 점수화** — gate가 아니라 **우선순위**.

```typescript
type MicroScore = {
  quality: number;     // 0-1, 진입 품질
  direction: "long" | "short" | "neutral";
  signals: {
    relativeStrength: number;  // vs universe percentile
    rsi: number;
    volumeSpike: number;
    smaDistance: number;        // 추세 이탈도
  };
};

function scoreCoin(candles: Candle[], universeData: UniverseData): MicroScore {
  // 낮은 점수 = 진입 안 함
  // 높은 점수 = 진입 우선
}
```

### Strategy Router

```
macro=bull    → Rotation: 상위 N개 코인 매수, micro score로 교체 판단
macro=bear    → Vol-Exhaustion: 급락(micro volumeSpike) 감지된 코인만 진입
macro=neutral → Cash: 전 포지션 청산, 거래 안 함
```

### Portfolio Manager

```
bull:     max 5 positions, trailing exit, rebalance 5-bar
bear:     max 3 positions, 빠른 exit (profitTarget 2-3%)
neutral:  0 positions
fee:      0.025% per side
```

## 구현 계획

### Step 1: `regime-system.ts` 신규 파일 (~200줄)

- `detectMacroRegime()`: crypto-regime-gate.ts의 adaptive scoring 이식
- `scoreCoin()`: relative strength + RSI + volume + SMA distance
- `MacroRegimeState`: cooldown, transition tracking
- market-state.ts 수정 없음

### Step 2: `regime-portfolio-v2.ts` 신규 파일

- `runRegimePortfolioV2()`: regime-system.ts를 사용하는 포트폴리오 runner
- 기존 multi-strategy engine 사용
- rotation은 **regimePass 체크 비활성화** (macro가 이미 필터링)
- vol-exhaustion은 bear일 때만 활성화

### Step 3: rotation 전략 수정

- `RelativeStrengthRotationStrategy.ts`에 `skipInternalRegimeCheck?: boolean` 옵션 추가
- 외부 regime system이 이미 필터링하면 내부 regimePass를 skip
- 기존 동작은 default로 유지 (하위 호환)

### Step 4: 테스트

- 연도별 (2021 상승, 2022 하락, 2023 횡보, 3yr)
- BTC 단일 결과 (+672% adaptive, +1866% hybrid)와 비교
- 멀티마켓 결과 (+54.1% rotation-only)보다 높은지 확인

### Step 5: auto-research

- rotation 파라미터 최적화 (내부 regime 없이)
- vol-exhaustion 파라미터 최적화 (bear 전용)

## 현재 시스템과의 차이

| | 현재 (market-state.ts) | 새 시스템 (regime-system.ts) |
|---|---|---|
| Macro 입력 | 모든 코인 × 3 anchor | BTC 1h만 |
| Regime 분류 | 5개 (volatile이 93%) | 3개 (bull/bear/neutral) |
| Micro 역할 | regime gate (차단) | 점수 (우선순위) |
| Timeframe | strategy와 동일 | macro=1h 고정 |
| 복잡도 | 1300줄 | ~200줄 |
| 호환성 | 기존 전략 전부 사용 | 새 전략만 사용, 기존 무영향 |

## 검증 기준

- 3yr 수익 > +54.1% (현재 rotation-only 최고)
- 2022 하락장 손실 < -5% (방어력)
- DD < 15%
- BTC 단일 대비 멀티마켓 장점 확인 (분산 효과)

## 참고 파일

- `crypto-regime-gate.ts`: adaptive scoring (이 로직을 regime-system.ts로 이식)
- `regime-switching-backtest.ts`: BTC 단일 검증 (6yr +672%)
- `RelativeStrengthRotationStrategy.ts`: rotation 전략 (내부 regime 수정 필요)
- `regime-portfolio-runner.ts`: 현재 포트폴리오 runner (v2로 교체 예정)
