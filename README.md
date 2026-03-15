# 멀티 전략 자동매매 시스템 handoff

이 패키지는 Codex에게 바로 넘길 수 있는 설계 문서와 프롬프트를 담고 있습니다.

## 파일 구성

- `docs/multi-strategy-system-design.md`
  - 고빈도 + 추세 자동매매를 동시에 운영하기 위한 전체 시스템 설계 문서
- `prompts/codex_multi_strategy_prompt.txt`
  - Codex에 바로 붙여 넣을 수 있는 구현 지시 프롬프트

## 권장 사용법

저장소 루트에 문서를 복사한 뒤 Codex에게 아래처럼 요청합니다.

```text
이 저장소를 docs/multi-strategy-system-design.md 기준으로 재설계하고 구현해줘.
프롬프트는 prompts/codex_multi_strategy_prompt.txt를 참고해.
분석만 하지 말고 실제 코드 수정, 테스트 추가, 문서 업데이트까지 수행해.
```
