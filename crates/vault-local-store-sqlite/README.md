# vault-local-store-sqlite

Secure Vault의 **합성 데이터 전용** 암호문 SQLite 저장 adapter입니다. 실제 비밀번호, API 키, Secret, 복구 키 또는 개인 금고 데이터를 저장하도록 승인된 crate가 아니며, 그 자체로 사용할 수 있는 비밀번호 관리자가 아닙니다.

## 구현된 경계

- password envelope와 record envelope를 opaque BLOB으로 저장하는 schema v1
- immutable revision, canonical head, expected-head CAS와 stale conflict 보존
- application/schema/version 검사와 row·BLOB·aggregate 상한을 적용하는 no-create read-only preflight
- current envelope 인증 뒤 같은 OS process lock을 유지하는 no-create writable 승격
- 재시작 후 current head의 authenticated restore
- future version의 upgrade-required 원문 보존과 current 손상의 store-wide 읽기 전용 보존
- commit 전·후 process 종료 원자성 및 secret-bearing API compile-fail 회귀

이 crate는 `VaultSession`, master password 또는 열린 plaintext model을 직접 받지 않습니다. 외부에 raw `rusqlite::Connection`이나 caller-supplied SQL/generic query API를 제공하지 않으며, raw locator·ID·nonce·AAD·entropy로 current row를 만드는 public constructor도 제공하지 않습니다.

## 보장 경계

SQLite에는 의미 있는 금고 내용을 평문으로 저장하지 않지만 schema/wire/suite version, 무작위 opaque graph, envelope 크기, revision 수, head/conflict 관계, 파일 크기·수정 시각·접근 패턴은 관찰될 수 있습니다. Password envelope는 전체가 암호문이 아니라 wrapped Vault Root Key를 포함한 직렬화 envelope BLOB입니다.

현재 구현은 유효한 과거 DB/WAL 전체 복원, canonical-head rollback 또는 record/revision 전체 누락을 탐지하지 못합니다. 같은 process의 RO→RW logical digest는 persisted/authenticated freshness proof가 아닙니다. Crash test는 SQLite transaction의 process-termination 가시성을 검증할 뿐 임의 hardware power-loss 내구성을 증명하지 않습니다.

## 파일과 backup 주의

- live WAL DB의 main 파일만 복사하면 일관된 backup이 아닙니다.
- DB, `-wal`, `-shm`, rollback journal, backup 또는 export를 Git/worktree/cloud-sync/network-share에 두거나 커밋하지 않습니다.
- 지원되는 backup/export API는 아직 없습니다. 후속 구현은 SQLite Online Backup API 또는 `VACUUM INTO`로 일관된 snapshot을 만든 뒤 무결성·envelope 검사와 실제 복구 훈련을 통과해야 합니다.

## 실제 Secret gate

rollback/누락 anchor, recovery Key Slot, hardware-backed device key·biometric flow, Android 통합, sync/checkpoint, 독립 암호 검토, 침투 테스트와 backup/export 복구 훈련이 모두 완료될 때까지 실제 Secret 입력은 금지됩니다.
