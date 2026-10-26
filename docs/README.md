# KeyAtlas 문서 안내

KeyAtlas 문서는 보안 설계와 합성 데이터 검증을 우선합니다. **처음에는 아래 청사진 한 개만 읽으세요.** 현재 상태·전체 구조·남은 작업·사용자 결정을 모았습니다.

1. [`handoff/KEYATLAS_UNIFIED_MASTER_BLUEPRINT_2026-09-25.md`](./handoff/KEYATLAS_UNIFIED_MASTER_BLUEPRINT_2026-09-25.md) — **일상적인 단일 진입점**

세부 구현·검증·협업 계약이 필요할 때만 원문을 열어 보세요. 기존 문서는 완전 동일본이 아니며 다른 문서에서 참조하므로, 안전한 이관·링크 검증 전에는 보존합니다.

- [`MVP.md`](./MVP.md), [`ARCHITECTURE_STATUS_MAP.md`](./ARCHITECTURE_STATUS_MAP.md) — 기능 범위·구현 기록
- [`RELEASE_READINESS_CHECKLIST.md`](./RELEASE_READINESS_CHECKLIST.md), [`verification/`](./verification/) — 출시 조건·검증 증거
- [`THREAT_MODEL.md`](./THREAT_MODEL.md), [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) — 상세 위협·보안 불변식
- [`handoff/KEYATLAS_ZERO_TO_PUBLIC_SERVICE_CHECKLIST_2026-09-18.md`](./handoff/KEYATLAS_ZERO_TO_PUBLIC_SERVICE_CHECKLIST_2026-09-18.md), [`handoff/KEYATLAS_UNIVERSAL_AI_HANDOFF_AND_TODO_2026-09-24.md`](./handoff/KEYATLAS_UNIVERSAL_AI_HANDOFF_AND_TODO_2026-09-24.md) — 이전 상세 작업판·인계 이력
- [`handoff/KEYATLAS_EXTERNAL_AI_COLLAB_BRANCHES_2026-09-18.md`](./handoff/KEYATLAS_EXTERNAL_AI_COLLAB_BRANCHES_2026-09-18.md) — 외부 AI용 `(22)~(35)` 브랜치 계약

검증 문서는 합성 데이터인지, 로컬에서 실행했는지, 브라우저에서 직접 확인했는지를 구분해서 읽어 주세요. 실제 Secret은 저장소나 fixture에 넣지 않습니다.
