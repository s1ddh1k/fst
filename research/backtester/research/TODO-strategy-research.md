# 전략 연구 TODO

## 1. 전략 다듬기 (즉시 가치)

- [ ] BB 주간형 미탐색 조합: 엄격 진입(entryPercentB -0.2) + 낮은 exitRsi(45-48) + stopLoss(20-25%)
- [ ] BB 일간형 과다 트레이드 해결: bbMultiplier/entryPercentB 더 엄격하게
- [ ] Leader worst window(-0.72%) 방어: breadth gate 미세 조정
- [ ] 3개 전략(Leader + BB주간 + Reversion) 포트폴리오 합성 백테스트
- [ ] 마켓 수 20→30+ 확대 테스트
- [ ] paper trading 연결 검증

## 2. 아이디어 → 자동 구현 파이프라인

사람이 자연어로 전략 아이디어 입력하면 자동으로 코드 생성 + 백테스트 + 리포트.

- [ ] 자연어 → ScoredStrategy 코드 생성 (code-agent.ts 활성화/개선)
- [ ] 생성된 코드 컴파일 검증 + block family 자동 등록
- [ ] 백테스트 자동 실행 → 결과 리포트
- [ ] 예: "RSI 30 이하 매수, MACD 골든크로스 매도, 손절 -15%"

## 3. 지표 조합 자동 제안

LLM이 사용 가능한 지표 카탈로그를 보고 새로운 전략 조합을 제안.

- [ ] 지표 카탈로그 정리 (BB, RSI, EMA, SMA, MACD, Stochastic, ADX, Donchian, CCI, OBV, ATR, Z-Score, Momentum, ROC, Historical Volatility)
- [ ] 전략 아키타입 템플릿 정의 (mean-reversion, trend-following, breakout, rotation)
- [ ] LLM 프롬프트: 지표 + 아키타입 → 새 전략 제안
- [ ] 제안 → 사람 승인 → 자동 구현 (#2) 연결

## 4. 성공 패턴 학습 + 변형 자동 탐색

흑자 전략의 공통 패턴을 추출해서 자동으로 변형 생성.

- [ ] 흑자 전략 메타데이터 수집: 진입 유형, exit 구조, 타임프레임, 빈도, win rate
- [ ] 패턴 일반화: "지표 X 극단값 → 매수 → 지표 Y 정상화 → 매도"
- [ ] 조합 자동 생성: Stochastic 과매도+BB하단, CCI극단+RSI과매도 등
- [ ] 성공/실패 이력 DB 축적 → LLM 프롬프트에 컨텍스트로 제공

## 우선순위

1번 > 2번 > 3번 > 4번
(이미 흑자인 전략 다듬기 → 새 아이디어 빠른 검증 → 새 전략 발굴 → 장기 자동화)
