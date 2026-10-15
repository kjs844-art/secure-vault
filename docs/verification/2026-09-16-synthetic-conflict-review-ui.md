# 2026-09-16 합성 conflict review UI 검증

기준 작업트리: `codex/firstvibe-local-session-hardening`의 기존 미커밋 변경 위에 추가한
합성 conflict outbox 사용자 검토 경계다. 이 기록은 합성 데이터 전용 웹 세션과
IndexedDB/WASM 회귀 증거이며 실제 자격 증명 또는 출시 승인 증거가 아니다.

`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`.

## 구현 경계

- 기존 IndexedDB schema/version, store primitive, Worker protocol, WASM archive 형식은
  변경하지 않았다.
- `SyntheticVaultSession`이 `listConflictArchives()` 결과를 최대 8개로 다시 검증하고,
  각 후보를 기존 `worker.open()`으로 순차 인증한다. 모든 후보가 성공해야만 frozen catalog
  projection을 한 번에 게시한다. 부분 성공 목록은 게시하지 않는다.
- 공개 review state에는 `reviewVersion`, 위치 기반 `reference`, 인증된 catalog projection만
  포함한다. 저장소 `conflictId`와 암호문 bytes는 공개 state, React props, DOM에 전달하지 않는다.
- storage ID와 exact-byte snapshot은 Session private map만 소유한다. `reviewVersion + reference`
  조합이 현재 화면에만 유효한 ephemeral reference다.
- lock, auto-lock cleanup/unmount, open/create/register/edit 시작은 review version을 증가시키고
  공개 projection과 private snapshot을 폐기한다. 늦은 list/Worker/delete 완료는 새 화면을
  다시 채우지 못한다.
- 폐기는 `폐기 검토`와 `확인하고 후보 폐기`의 두 사용자 동작을 거친 뒤에만
  `deleteConflictArchiveIfEqual(conflictId, reviewedBytes)`를 호출한다. 첫 단계와 취소는
  저장소를 호출하지 않는다.
- `deleted` 뒤 자동 relist는 없다. `changed` 또는 `missing`은
  `CONFLICT_REVIEW_STALE`, 알려진 storage 오류는 고정 storage code, 그 밖의 throw는
  `OPERATION_FAILED`로 닫힌다. 자동 retry/merge/promote/evict 또는 현재 archive 쓰기는 없다.
- UI는 기존 class와 catalog result renderer만 재사용했다. final styling은 추가하지 않았다.

## 상태 흐름

```text
idle -> loading -> ready -> confirm-discard -> discarding
                 |          |                  |-- deleted -> discarded
                 |          |-- cancel -> ready|-- changed/missing/throw -> error
                 |-- auth/list failure -> error

any state -- lock/unmount/new vault operation --> idle + newer reviewVersion
```

`discarded`와 `error`에서 목록을 다시 읽으려면 사용자가 `후보 목록 확인`을 직접 눌러야 한다.
후보 번호는 random conflict ID 정렬에서 나온 현재 화면 위치일 뿐 생성 시각 또는 최신 순서를
뜻하지 않는다.

## 자동 검사 증거

아래 명령은 2026-09-16 현재 작업트리에서 실행했다.

| 실행 명령 | 결과 |
|---|---|
| `npm test -- --run src/features/local-vault/SyntheticConflictReview.test.ts src/features/local-vault/SyntheticConflictReviewPanel.test.tsx --maxWorkers=1` | exit 0, 2 files, **25/25** |
| 관련 session/edit/WASM/auto-lock 6개 파일 집중 실행 | exit 0, 6 files, **153/153** |
| `npm test -- --run` | exit 0, 25 files, **918/918** |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0, Vite 43 modules, WASM 313.18 kB |
| 지정 변경 파일 `git diff --check` | exit 0 |

집중 검사는 다음 경계를 포함한다.

- 0개/8개 후보 허용과 9개, 중복/잘못된 ID, 잘못된 bytes의 fail-closed 처리
- 모든 후보 인증 완료 전 빈 공개 목록, 중간 인증 실패 시 부분 projection 비게시
- conflict ID/bytes 비공개와 원본 배열 변경에도 고정된 private exact-byte snapshot 사용
- 직접 confirm, stale version/reference, cancel에서 delete 미호출
- `changed`, `missing`, quota/unknown throw에서 고정 오류 및 자동 relist/read/retry 없음
- list/후보 인증/delete 대기 중 lock의 stale publication 차단
- 새 vault 작업과 auto-lock cleanup/unmount의 review plaintext 참조 폐기
- 실제 생성 WASM + fake IndexedDB에서 인증된 loser projection 확인, 두 단계 폐기,
  폐기 전후 current archive 전체 bytes 동일 확인

## 남은 검증 경계

- 실제 Chromium 멀티탭에서 동시에 쓰고 review 버튼을 조작하는 브라우저 통합 검사는 아직
  수행하지 않았다. actual-WASM 검사는 Node + fake IndexedDB 경계다.
- JavaScript 문자열의 물리적 메모리 zeroization은 보장하지 않는다. lock/unmount 보장은
  Session/React state 참조 제거, worker 취소, stale 재게시 차단이다.
- 후속 backup guard는 미해결 후보가 있으면 합성 export를 막는다. outbox 포함
  wire/version, 병합/승격/복구 workflow와 원자적 snapshot 정책은 구현하지 않았다.
- 실제 Secret 입력, 사용자 인증, 동기화, rollback/누락 anchor, 모바일 통합은 열지 않았다.
- 이 검증은 기존 미커밋 변경이 함께 있는 현재 작업트리에서 수행했으며 commit/push는 하지 않았다.
