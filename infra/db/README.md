# db

데이터베이스 스키마와 초기화 파일을 관리하는 디렉터리다.

포함 항목:

- 초기 테이블 생성 SQL
- 인덱스 및 제약조건
- 수동 적용 가능한 마이그레이션 SQL

주의:

- `docker-compose.yml`은 `./data/postgres`를 직접 마운트한다.
- 따라서 기존 데이터 디렉터리가 이미 있으면 `init.sql` 변경사항은 자동 반영되지 않는다.
- 스키마 변경이 필요하면 별도 마이그레이션 SQL을 수동 적용해야 한다.

현재 추가된 수동 마이그레이션:

- [20260317_add_market_feature_tables.sql](/home/eugene/git/fst/infra/db/20260317_add_market_feature_tables.sql)
  - `market_breadth_features`
  - `market_relative_strength_features`
