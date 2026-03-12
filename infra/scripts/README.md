# scripts

로컬 실행 및 운영 보조 스크립트를 두는 디렉터리다.

예정 스크립트:

- DB 초기화
- 데이터 수집 실행
- 백테스트 실행
- 모의투자 엔진 실행

현재 포함 스크립트:

- `tmux-fst.sh`
- `run-overnight-backfill.sh`
- `check-collector-status.sh`
- `run-paper-session.sh`
- `check-paper-session-status.sh`

`tmux-fst.sh`는 로컬 운영용 `fst` tmux 세션을 정리한다.

- `up`: `overview`, `desktop`, `collector`, `paper`, `logs` 윈도우를 만든다.
- `attach`: 세션이 없으면 생성하고 바로 붙는다.
- `status`: 세션과 윈도우 목록을 출력한다.
- `down`: 세션을 종료한다.

`check-collector-status.sh`는 다음 정보를 함께 본다.

- 최근 collector runs
- collector state
- detected gaps
- system logs

`run-paper-session.sh`는 다음 순서로 동작한다.

- 추천 레짐 기준으로 paper session 생성
- `paper-trader run-session`을 백그라운드 실행
- 로그 파일을 `logs/paper-session-*.log`로 저장

`check-paper-session-status.sh`는 다음 정보를 함께 본다.

- session 요약
- 현재 position
- 최근 order 20건
