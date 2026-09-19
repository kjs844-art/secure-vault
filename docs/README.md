# KeyAtlas 문서 안내

KeyAtlas 문서는 보안 설계와 합성 데이터 검증을 우선합니다. 처음 읽는 경우 아래 순서를 권장합니다.

1. [`MVP.md`](./MVP.md) — 현재 제품 범위와 우선순위
2. [`ARCHITECTURE_STATUS_MAP.md`](./ARCHITECTURE_STATUS_MAP.md) — 구현 상태 지도
3. [`RELEASE_READINESS_CHECKLIST.md`](./RELEASE_READINESS_CHECKLIST.md) — 단계별 출시 조건
4. [`verification/`](./verification/) — 실제로 확인한 검증 기록
5. [`THREAT_MODEL.md`](./THREAT_MODEL.md) — 위협과 보호 경계

전체 출시 순서와 외부 AI 협업 브랜치를 확인하려면 다음 문서를 함께 봅니다.

6. [`handoff/KEYATLAS_ZERO_TO_PUBLIC_SERVICE_CHECKLIST_2026-09-18.md`](./handoff/KEYATLAS_ZERO_TO_PUBLIC_SERVICE_CHECKLIST_2026-09-18.md) — 0부터 공개 Web·Android 서비스까지 전체 체크리스트
7. [`handoff/KEYATLAS_EXTERNAL_AI_COLLAB_BRANCHES_2026-09-18.md`](./handoff/KEYATLAS_EXTERNAL_AI_COLLAB_BRANCHES_2026-09-18.md) — 외부 AI용 `(22)~(35)` 브랜치와 허용 범위

검증 문서는 합성 데이터인지, 로컬에서 실행했는지, 브라우저에서 직접 확인했는지를 구분해서 읽어 주세요. 실제 Secret은 저장소나 fixture에 넣지 않습니다.
