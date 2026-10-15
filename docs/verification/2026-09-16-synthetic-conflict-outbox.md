# 2026-09-16 합성 암호문 conflict outbox 검증

기준 작업트리: `codex/firstvibe-local-session-hardening`의 미커밋 변경.
이 기록은 합성 데이터 전용 IndexedDB/세션 경계의 구현 및 자동 검사 증거다.
실제 자격 증명, 운영 계정 또는 출시 승인이 아니다.

`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`.

## 저장 계약

기존 IndexedDB 이름 `keyatlas-synthetic-vault-v1`, DB version `1`, object store
`bundle`은 바꾸지 않았다. 논리 keyspace만 다음처럼 제한한다.

```text
archive                         현재 암호문 archive 1개
conflict:<32 lowercase hex>     보존된 암호문 충돌 후보, 최대 8개
```

- `archive`가 없는데 conflict key만 남은 orphan, 잘못된 key/값, 8개를 초과한 raw
  keyspace는 `corrupt`로 닫히며 자동 삭제·초기화하지 않는다.
- conflict ID는 16 random bytes를 32자리 소문자 hex로 만든다. ID 충돌은 기존 항목을
  덮어쓰지 않고 고정 실패로 닫힌다.
- 8개가 차면 `outbox-full`을 반환한다. 오래된 후보의 자동 퇴거, 자동 재시도,
  자동 병합 또는 현재 archive 덮어쓰기는 없다.
- 저장소의 `listConflictArchives`와 exact-byte 조건부 삭제 primitive는 구현·단위 검사했다.
  그러나 사용자가 보는 목록·폐기(discard)·해결·병합 UI에는 아직 연결하지 않았다.

## 원자적 CAS 및 보존 흐름

`compareAndSwapArchivePreservingConflict(expected, next)`는 keyspace 검사, 현재 archive
전체 byte 비교, 현재본 교체 또는 충돌 후보 `add`를 하나의 IndexedDB `readwrite`
transaction 안에서 수행한다.

```text
표시 snapshot → Worker 편집 후보 생성 → 후보 전체 사전 인증
    ↓
원자적 CAS
    ├─ current == expected → archive = candidate → updated
    ├─ current != expected → archive 유지 + conflict:candidate 추가
    │                         → conflict-preserved
    └─ archive 없음 → missing, 생성하지 않음
    ↓
저장본 readback + 재인증
    ├─ candidate와 같음 → 성공 화면 게시
    └─ 다른 writer가 이미 변경 → candidate와 current를 다시 한 transaction에서 비교
                               → 다르면 conflict로 보존
                               → 같으면 이미 현재본으로 처리
```

세션은 별도 pre-CAS 저장소 read에 의존하지 않는다. 표시 당시 소유 snapshot으로 후보를
만든 뒤 `worker.open`으로 **완성된 후보 전체를 인증하고 그 projection은 버린 다음** CAS를
호출한다. CAS가 `updated`여도 readback이 후보와 다르면 성공으로 표시하지 않고
`preserveConflictArchiveIfCurrentDiffers`로 post-CAS race 후보를 보존한다. 보존이 실제로
커밋된 뒤에만 `STORAGE_CONFLICT_PRESERVED`를 게시한다.

request success만으로 성공을 반환하지 않고 transaction `complete`를 기다린다. add 성공 뒤
abort, quota/request 오류, outbox full 검사는 현재 archive와 기존 outbox를 보존하는 회귀로
확인했다. 이 증거는 브라우저 구현 일반의 crash durability 보증은 아니다.

## SharedArrayBuffer 경계

Store 입력과 저장값, Session 후보/저장본, Worker client/worker, Backup 경로는 네이티브
`Uint8Array.buffer` getter 뒤 `ArrayBuffer.prototype.byteLength` brand check를 사용한다.
따라서 Store 호출 입력의 `SharedArrayBuffer` view는 DB open 전에 거부된다. 저장소에서
읽은 값과 Session/Worker/Backup 경계의 view도 다음 후보 인증, Worker/WASM 호출 또는 성공
게시 전에 독립 snapshot으로 검증되며, 위조된 own `buffer`/`byteLength`를 신뢰하지 않는다.

이는 Node/fake IndexedDB 단위 검사에서 확인한 사전 거부 경계다. 실제
cross-origin-isolated 브라우저에서 공유 메모리를 동시에 변경하는 통합 검사는 실행하지 않았다.

## 실행 증거

아래 집중 검사는 2026-09-16 현재 작업트리에서 이 문서 작성 중 다시 실행했다.

| 실행 명령 | 결과 |
|---|---|
| `npm.cmd test --prefix apps/web -- src/storage/SyntheticCiphertextStore.test.ts --maxWorkers=1` | exit 0, 1 file, **104/104** |
| `npm.cmd test --prefix apps/web -- src/features/local-vault/SyntheticVaultConnectionEdit.test.ts --maxWorkers=1` | exit 0, 1 file, **62/62** |
| `npm.cmd test --prefix apps/web -- src/features/local-vault/SyntheticVaultConnectionEdit.wasm.test.ts --maxWorkers=1` | exit 0, 1 file, **4/4**; 실제 생성 WASM + Node + fake IndexedDB |

후속 독립 리뷰 보강까지 반영한 현재 트리의 `apps/web` 통합 검사 기록은 다음과 같다.
위 집중 재실행 수치와 중복 집계하지 않는다.

| 실행 명령 | 결과 |
|---|---|
| `npm test -- --run` | exit 0, 23 files, 통합 웹 **891/891** |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0, Vite 42 modules, WASM asset 313.18 kB |

outbox 구현 직후 같은 통합 검사는 889/889였다. 이후 Backup readback의 SAB·위조 길이
거부 회귀 2개를 추가하고 독립 재검토한 뒤 최종 현재 트리 수치가 891/891로 갱신됐다.

WASM 4개는 인증된 winner와 별도 인증된 loser의 재시작 확인, 그리고 CAS 성공 직후
다른 writer가 바꾼 후보의 보존을 포함한다. 브라우저 Worker/cancellation이나 실제 브라우저
저장소 검증은 아니다.

## 미구현·미검증 경계

- 실제 브라우저 멀티탭의 동시 writer/트랜잭션/재시작 동작은 검증하지 않았다.
- 연결 편집 UI의 실제 저장·취소·포커스·잠금·충돌 전체 흐름은 완료 검증하지 않았다.
- 후속 [conflict 검토 UI](2026-09-16-synthetic-conflict-review-ui.md)에서 전체 후보 인증,
  위치 기반 목록과 exact-byte 2단계 폐기를 구현했다. 자동 해결·병합·승격은 없다.
- 후속 [backup conflict guard](2026-09-16-synthetic-backup-conflict-guard.md)는 미해결
  후보가 있으면 합성 export를 막는다. 후보를 backup에 포함하는 wire/version과 원자적
  snapshot 정책은 정하지 않았다.
- 자동 병합·자동 재시도·자동 퇴거, signed rollback/누락 anchor, 키 회전 workflow,
  동기화·모바일·복구는 구현하지 않았다.
- fake IndexedDB와 Node 통과는 실제 브라우저 crash durability, 운영 보안 또는 실사용
  Secret 지원을 증명하지 않는다.

따라서 이번 체크포인트의 결론은 **합성 암호문 후보의 제한된 원자 보존 경로와 자동 회귀가
통과했다**는 것이다. 실제 브라우저 conflict UX 또는 실사용 금고 완료 판정은 아니다.
