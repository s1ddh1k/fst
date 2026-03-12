# 업비트 자동매매 앱 기술 설계 문서

## 1. 문서 목적

이 문서는 MVP 기능 명세를 실제 구현 가능한 기술 구조로 구체화하기 위한 설계 문서다.

다음 항목을 정의한다.

- 저장소 구조
- 프로세스 경계
- 서비스 간 데이터 흐름
- 데이터 저장 방식
- 패키지 책임 분리
- 보안 및 운영 원칙

이 문서는 이후 저장소 초기화와 실제 구현의 기준이 된다.

## 2. 설계 원칙

프로젝트는 다음 원칙을 따른다.

- UI와 매매 엔진을 분리한다.
- 연구용 코드와 운영용 코드를 분리한다.
- 원본 데이터와 가공 데이터를 분리한다.
- 민감 정보는 UI 프로세스에 노출하지 않는다.
- 초기에는 단순하고 교체 가능한 구조를 우선한다.
- 실거래 확장을 고려하되 MVP에서는 모의투자 중심으로 설계한다.

## 3. 최상위 아키텍처

MVP는 다음 5개 실행 단위로 구성한다.

1. `data-collector`
2. `backtester`
3. `paper-trader`
4. `desktop-app`
5. `database`

각 실행 단위는 역할이 다르며, 직접 결합을 최소화한다.

## 4. 프로세스 구성

### 4.1 desktop-app

역할:

- Electron 메인 프로세스
- React 렌더러 UI
- 로컬 서비스 상태 표시
- 사용자 명령 전달

책임:

- 전략 목록 조회
- 백테스트 결과 조회
- 모의투자 시작/중지 요청
- 실시간 손익/로그 표시

비책임:

- 업비트 API 직접 호출
- 주문 처리
- 민감한 시크릿 저장 및 사용

### 4.2 data-collector

역할:

- 업비트 과거 시세 수집 배치 서비스
- 실시간 시세 수신 준비 레이어

책임:

- 마켓 메타데이터 조회
- 캔들 데이터 장기 적재
- 누락 구간 재수집
- 수집 로그 기록

### 4.3 backtester

역할:

- 연구 및 검증 전용 실행 모듈

책임:

- 데이터 로딩
- 전략 실행
- 비용 반영
- 지표 계산
- 결과 저장

### 4.4 paper-trader

역할:

- 실시간 모의투자 엔진

책임:

- WebSocket 시세 수신
- 전략 평가
- 가상 주문 생성
- 가상 체결 처리
- 포지션/잔고/로그 상태 관리

### 4.5 database

역할:

- 장기 데이터 저장
- 실행 결과 저장
- 상태 조회 기반 제공

## 5. 저장소 구조

권장 저장소 구조는 아래와 같다.

```text
fst/
  apps/
    desktop/
  services/
    data-collector/
    paper-trader/
  research/
    backtester/
    strategies/
  packages/
    shared/
  infra/
    db/
    scripts/
  docs/
```

## 6. 패키지별 책임

### 6.1 `apps/desktop`

구성:

- Electron main
- Electron preload
- React renderer

책임:

- 데스크톱 앱 진입점
- IPC 브리지 정의
- 상태 조회 UI
- 모의투자 제어 UI

기술:

- Electron
- React
- TypeScript
- Vite

### 6.2 `services/data-collector`

책임:

- 업비트 REST 호출 래퍼
- 캔들 수집 배치 실행기
- 수집 상태 저장
- 데이터 정규화 및 upsert

기술:

- Node.js
- TypeScript
- undici 또는 axios
- `pg` 또는 ORM

실행 방식:

- CLI 명령
- 예약 실행 가능 구조

### 6.3 `services/paper-trader`

책임:

- WebSocket 연결 관리
- 실시간 캔들 또는 틱 상태 관리
- 전략 호출
- 포지션 상태 갱신
- 이벤트 발행

기술:

- Node.js
- TypeScript
- ws 또는 WebSocket client
- Fastify 또는 Express

실행 방식:

- 로컬 장기 실행 프로세스

### 6.4 `research/backtester`

책임:

- 데이터셋 로더
- 전략 실행 루프
- 성능 계산기
- 검증 실행기

기술:

- Node.js
- TypeScript
- danfojs 또는 직접 시계열 계산 유틸리티
- fast-csv 또는 parquet 도구

### 6.5 `research/strategies`

책임:

- 공통 전략 인터페이스
- 전략 구현
- 파라미터 스키마

전략 구현 예:

- moving_average_cross
- volatility_breakout
- rsi_mean_reversion

### 6.6 `packages/shared`

책임:

- 공통 설정 값
- 공통 타입 정의
- 공통 이벤트 이름
- 직렬화 규약

주의:

- 모든 런타임이 TypeScript 계열이므로 공통 타입과 이벤트 규약을 직접 공유할 수 있다.

## 7. 기술 스택 결정

MVP 기준 권장 스택은 아래와 같다.

- UI: Electron + React + TypeScript
- 데이터 수집: Node.js + TypeScript
- 백테스트: Node.js + TypeScript
- 모의투자 엔진: Node.js + TypeScript
- DB: PostgreSQL
- 연구용 파일 포맷: CSV 또는 Parquet

이 조합을 권장하는 이유는 다음과 같다.

- 단일 언어 스택으로 개발과 운영 복잡도를 줄일 수 있다.
- Electron 앱과 서비스 간 타입 공유가 쉬워진다.
- PostgreSQL은 운영 데이터와 조회 API에 안정적이다.
- CSV 또는 Parquet는 분석 반복 실행에 유리하다.

## 8. 데이터 흐름

### 8.1 과거 데이터 적재 흐름

1. `data-collector`가 업비트 REST API에서 캔들을 조회한다.
2. 원본 응답을 정규화한다.
3. DB에 캔들 데이터를 upsert한다.
4. 필요 시 Parquet 분석 파일을 생성한다.

### 8.2 백테스트 흐름

1. `backtester`가 DB 또는 Parquet에서 데이터를 로드한다.
2. 학습 구간과 검증 구간을 분리한다.
3. 전략별로 실행한다.
4. 지표를 계산한다.
5. 결과를 DB에 저장한다.

### 8.3 모의투자 흐름

1. `desktop-app`에서 전략 실행 요청을 보낸다.
2. `paper-trader`가 요청을 받아 세션을 시작한다.
3. 업비트 WebSocket에서 실시간 데이터를 수신한다.
4. 전략이 신호를 생성한다.
5. 가상 주문/체결을 수행한다.
6. 상태와 로그를 DB 및 메모리 상태에 반영한다.
7. `desktop-app`이 상태를 polling 또는 stream 방식으로 표시한다.

## 9. 통신 방식

MVP에서는 복잡한 분산 아키텍처를 피하고 로컬 단일 머신 기준으로 설계한다.

권장 방식은 다음과 같다.

- Electron 앱과 로컬 서비스 간 통신: HTTP + WebSocket 또는 IPC + local HTTP
- Node 서비스 내부 통신: 직접 DB 공유

권장 구조:

- `paper-trader`는 로컬 HTTP API와 상태 WebSocket을 제공
- `desktop-app`는 이 API를 호출해 세션 제어 및 상태 수신

이 방식의 장점:

- UI와 엔진을 분리할 수 있다.
- 실거래 엔진으로 확장하기 쉽다.
- 장애 원인 분리가 쉽다.

## 10. 데이터 저장 설계

### 10.1 저장소 선택

MVP는 PostgreSQL을 주 저장소로 사용한다.

보조 저장소로 Parquet를 사용한다.

- PostgreSQL:
  - 운영 상태
  - 실행 기록
  - 조회 API
- Parquet:
  - 대량 백테스트 입력
  - 연구용 캐시

### 10.2 핵심 테이블

#### `markets`

- `id`
- `market_code`
- `base_currency`
- `quote_currency`
- `display_name`
- `is_active`
- `created_at`
- `updated_at`

#### `candles`

- `id`
- `market_code`
- `timeframe`
- `candle_time_utc`
- `open_price`
- `high_price`
- `low_price`
- `close_price`
- `volume`
- `notional`
- `source`
- `created_at`

유니크 키:

- `market_code + timeframe + candle_time_utc`

#### `collector_runs`

- `id`
- `run_type`
- `market_code`
- `timeframe`
- `started_at`
- `finished_at`
- `status`
- `message`

#### `backtest_runs`

- `id`
- `strategy_name`
- `strategy_version`
- `parameters_json`
- `market_code`
- `timeframe`
- `train_start_at`
- `train_end_at`
- `test_start_at`
- `test_end_at`
- `started_at`
- `finished_at`
- `status`

#### `backtest_metrics`

- `id`
- `backtest_run_id`
- `segment_type`
- `total_return`
- `annualized_return`
- `max_drawdown`
- `sharpe_ratio`
- `sortino_ratio`
- `win_rate`
- `profit_factor`
- `trade_count`

#### `paper_sessions`

- `id`
- `strategy_name`
- `parameters_json`
- `market_code`
- `timeframe`
- `starting_balance`
- `current_balance`
- `status`
- `started_at`
- `ended_at`

#### `paper_orders`

- `id`
- `paper_session_id`
- `side`
- `order_type`
- `requested_price`
- `executed_price`
- `quantity`
- `fee`
- `slippage`
- `status`
- `created_at`
- `executed_at`

#### `paper_positions`

- `id`
- `paper_session_id`
- `market_code`
- `quantity`
- `avg_entry_price`
- `mark_price`
- `unrealized_pnl`
- `realized_pnl`
- `updated_at`

#### `system_logs`

- `id`
- `service_name`
- `level`
- `event_type`
- `message`
- `context_json`
- `created_at`

## 11. 전략 인터페이스 설계

전략은 공통 인터페이스를 따라야 한다.

예시 개념:

- 입력:
  - 현재 시점까지의 캔들 데이터
  - 현재 포지션 상태
  - 전략 파라미터
- 출력:
  - `BUY`
  - `SELL`
  - `HOLD`

추가 규칙:

- 전략은 외부 I/O를 직접 수행하지 않는다.
- 전략은 순수 함수에 가깝게 유지한다.
- 상태가 필요한 경우 상태 구조를 명시적으로 전달한다.

## 12. 백테스트 설계 원칙

백테스트 엔진은 다음 규칙을 가져야 한다.

- 미래 데이터를 참조하지 않는다.
- 거래 비용을 항상 반영한다.
- 슬리피지를 낙관적으로 두지 않는다.
- 결과는 재현 가능해야 한다.
- 파라미터와 입력 데이터 버전을 함께 저장한다.

### 12.1 기본 체결 모델

MVP는 다음 단순 모델을 사용한다.

- 신호 발생 후 다음 캔들 시가 체결
- 고정 수수료 적용
- 고정 슬리피지 또는 비율 슬리피지 적용

이 모델은 단순하지만 재현성과 구현 속도 측면에서 유리하다.

## 13. 모의투자 엔진 설계

### 13.1 상태 모델

모의투자 엔진은 아래 상태를 메모리와 DB에 유지한다.

- 현재 세션 상태
- 현재 현금 잔고
- 현재 포지션
- 최근 주문 목록
- 최근 로그
- 마지막 시세 수신 시각

### 13.2 세션 수명주기

1. `created`
2. `starting`
3. `running`
4. `stopping`
5. `stopped`
6. `error`

### 13.3 안전 동작

다음 상황에서는 자동 정지 또는 오류 상태로 전환한다.

- WebSocket 장시간 단절
- 시세 갱신 중단
- 전략 예외 발생
- 비정상 포지션 계산
- DB 기록 실패 반복

## 14. Electron 앱 설계

### 14.1 렌더러 책임

- 전략 목록 표시
- 성과표 표시
- 세션 상태 표시
- 사용자 입력 처리

### 14.2 메인 프로세스 책임

- 앱 시작 및 종료 관리
- 로컬 서비스 연결 중개
- preload를 통한 안전한 API 노출

### 14.3 preload 책임

- 렌더러에 최소한의 API만 노출
- 임의 Node API 노출 금지

## 15. 보안 설계

MVP에서도 다음 원칙은 반드시 지킨다.

- API 키는 실거래 도입 전까지 없어도 시스템이 동작해야 한다.
- 향후 실거래용 시크릿은 Electron 렌더러에 절대 노출하지 않는다.
- 시크릿 저장은 OS 키체인 또는 암호화 저장을 사용한다.
- 로그에는 민감 정보가 기록되지 않도록 한다.

## 16. 관측성 설계

최소한 아래 정보는 추적 가능해야 한다.

- 마지막 데이터 수집 성공 시각
- 데이터 수집 실패 횟수
- 백테스트 실행 기록
- 모의투자 세션 상태
- 최근 주문/체결 이벤트
- 최근 오류 로그

## 17. 개발 단계 연결

기술 설계 기준 구현 순서는 아래와 같다.

1. 저장소 디렉터리 초기화
2. 공통 설정 및 환경변수 구조 정의
3. DB 스키마 초안 작성
4. 데이터 수집기 구현
5. 백테스트 엔진 구현
6. 전략 구현
7. paper-trader 구현
8. Electron 앱 구현

## 18. 보류 결정

아래 항목은 지금 설계에 넣되 구현은 보류한다.

- 실거래 주문 라우터
- 멀티 전략 포트폴리오 엔진
- 사용자 계정 시스템
- 클라우드 동기화
- 원격 배포 자동화

## 19. 결론

MVP는 `TypeScript 기반 연구/엔진 + Electron UI + PostgreSQL 저장소` 구조로 가는 것이 가장 현실적이다.

핵심은 앱을 먼저 화려하게 만드는 것이 아니라, `데이터 적재`, `재현 가능한 백테스트`, `미학습 검증`, `실시간 모의투자 엔진 분리`를 먼저 올바르게 만드는 것이다.
