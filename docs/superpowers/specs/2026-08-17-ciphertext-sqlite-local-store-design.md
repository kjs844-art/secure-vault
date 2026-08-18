# 암호문 전용 SQLite 로컬 저장소 설계

- 상태: 사용자 명세 승인(2026-08-19), 구현 계획 진행
- 기준일: 2026-08-17
- 적용 제품: Secure Vault 합성 데이터 전용 `v0alpha1` 로컬 코어
- 기준 브랜치: `codex/firstvibe-credential-local-core` @ `e2727132b8afc298afaf3662ce77f0b12e81fd62`

## 1. 목적과 현재 경계

이번 단계는 메모리에만 존재하던 합성 자격 증명 레코드를 SQLite에 저장하고, 앱과 세션을 닫은 뒤 다시 열어 인증된 동일 관계를 복원하는 첫 영속 저장 계층이다. 저장소는 immutable revision, 단일 canonical head, `(opaque_record_id, expected_revision_id)` compare-and-swap(CAS), stale candidate의 암호화된 로컬 충돌 복구함을 제공한다.

이 단계도 **합성 데이터 전용**이다. 실제 아이디, 비밀번호, API 키, Secret, 복구 키, 세션 쿠키 또는 개인 금고 데이터의 입력·가져오기·저장은 허용하지 않는다. 공개 생성 입력은 기존의 닫힌 `SyntheticCredentialFixtureId`와 새로 정의할 닫힌 합성 successor 동작만 허용한다.

이번 단계가 완료되어도 실제 Secret 지원, 제품 복구 기능 또는 동기화가 완성됐다고 표현하지 않는다. GitHub에는 소스 코드와 설계만 올리며 SQLite 금고 파일, WAL, 백업 또는 export를 커밋하지 않는다.

## 2. 선택한 방식과 대안

### 선택: SQLite에 opaque envelope와 revision graph 저장

새 Rust crate `vault-local-store-sqlite`를 만들고 기존 canonical crypto envelope를 BLOB 그대로 저장한다. 한 SQLite transaction이 revision insert, idempotency 검사, canonical head CAS, 필요 시 conflict classification을 함께 처리한다.

이 방식을 선택한 이유는 다음과 같다.

- SQLite transaction으로 revision과 head가 반쪽만 남는 상태를 막을 수 있다.
- immutable revision과 stale writer 보존이 현재 승인된 자격 증명 관계 설계와 일치한다.
- 수천 항목에서도 전체 금고 파일을 매번 다시 쓰지 않는다.
- 같은 저장 계약을 후속 Android adapter와 로컬 sync outbox 설계가 재사용할 수 있다.
- 손상 범위를 레코드와 구조 검사로 나누어 진단할 수 있다.

### 제외한 대안 A: 금고 전체 단일 암호문 snapshot

파일 하나라 메타데이터 노출은 적지만 작은 수정에도 전체 파일을 다시 쓰고, concurrent revision·충돌 보존·증분 동기화가 어렵다. 현재 immutable revision/CAS 방향과 맞지 않는다.

### 제외한 대안 B: SQLCipher와 item AEAD의 이중 암호화

SQLCipher는 잠긴 기기에서 SQLite schema와 opaque graph까지 숨기는 추가 방어층이 될 수 있다. 그러나 DB key 생성·wrapping·rekey, native build, Android 호환성과 migration이라는 별도 키 생명주기가 생긴다. 이번 단계에서는 의미 있는 콘텐츠가 이미 item AEAD 안에 있으므로 도입하지 않고, 로컬 메타데이터 은닉이 별도 위협 요구로 확정될 때 재평가한다.

## 3. 정확한 보안 약속

SQLite 파일에 **의미 있는 금고 내용의 평문은 저장하지 않는다**. 다음 값은 기존 outer envelope 또는 저장 graph에 있으므로 로컬 파일을 가진 공격자가 관찰할 수 있다.

- storage schema·wire·suite 버전
- password envelope의 salt, KDF 파라미터와 vault commitment
- 무작위 `opaque_record_id`, `revision_id`, `key_epoch`, padding bucket
- envelope 크기, revision 수, canonical head와 conflict 관계
- DB·WAL 크기, 파일 수정 시각과 접근 패턴

다음 값은 item ciphertext 안에만 있어야 한다.

- 서비스·Console·계정·조직·프로젝트·환경
- 자격 증명 종류와 모든 Secret field
- 관계 지도를 재구축하는 연결처·MCP 설정·별칭·상태 원본 필드
- 태그·메모·만료·회전 시간

검색어와 파생 검색·관계 인덱스는 item ciphertext에도 DB에도 저장하지 않는다. 잠금 해제 중 원본 관계 필드에서 메모리로만 만들고 잠글 때 폐기한다.

Password envelope 전체를 암호문이라고 부르지 않는다. 정확한 표현은 **wrapped Vault Root Key를 포함한 직렬화 password envelope BLOB**이다.

DB 컬럼은 탐색용 cache일 뿐 권위가 아니다. current record에서는 strict canonical envelope가 제공하는 locator/AAD 필드가 유일한 권위이며, 컬럼은 매번 그 값과 정확히 일치해야 한다. SQLite는 envelope를 다시 직렬화하지 않고 원본 bytes를 보존한다.

## 4. 구성 요소와 의존 방향

```text
vault-local-store-sqlite
  |-- depends on --> vault-local-core
  |                    synthetic candidate + persistence projection
  |                    envelope-only rehydrate
  |
  `-- depends on --> vault-crypto
                       session-free storage inspection only

vault-local-core -- depends on --> vault-crypto

synthetic restart/crash integration harness -- depends on --> all three
```

Cargo 의존은 `vault-local-core -> vault-crypto`, `vault-local-store-sqlite -> vault-local-core + vault-crypto`의 acyclic 방향이다. Store crate의 `vault-crypto` import는 password/record storage inspection type과 non-secret metadata getter로 allowlist하고 `VaultSession`, `MasterPassword`, create/unlock/seal/open API import는 검증에서 금지한다.

### `vault-crypto`

기존 `inspect_*_v0alpha1 -> Result<()>` API는 유지한다. 저장 경계에는 private-field, read-only `PasswordEnvelopeStorageInspectionV1`과 `RecordEnvelopeStorageInspectionV1`을 추가한다.

- current password envelope에서 vault commitment를 읽되 Root Key·salt 원문 getter는 만들지 않는다.
- current record envelope에서 vault commitment, opaque record ID 16 bytes, revision ID 32 bytes, key epoch와 approved padding bucket만 읽는다.
- 65,536-byte 상한을 allocation 전에 적용하고 current format은 기존 strict canonical decoder 전체를 통과한다.
- unsupported wire 또는 suite는 locator를 write-capable 타입으로 승격하지 않고 `UpgradeRequired`로 분류한다.
- caller-provided nonce, AAD, entropy, ID 또는 mutable metadata constructor는 추가하지 않는다.

Future-wire 판별은 current fixed-array decoder와 분리한다. 먼저 1~65,536 bytes인지 확인하고, definite top-level CBOR array가 한 필드 이상이며 첫 필드가 minimal canonical unsigned `wire_version`인지까지만 bounded parse한다. `wire_version=0`이면 exact field count와 전체 canonical current decoder를 요구한다. `wire_version>0`이면 나머지 bytes를 신뢰하거나 해석하지 않고 원본 전체를 read-only opaque BLOB으로 보존한다. current layout 안의 unsupported suite도 전체 current-shape·canonical 검사를 통과한 경우에만 `UpgradeRequired`다. 이 discriminator는 future data의 진위나 완전성을 인증한다고 주장하지 않는다.

### `vault-local-core`

기존 `SealedCredentialRecordV0Alpha1`의 private-field 경계를 유지한다. 다음 두 저장 전용 경계를 추가한다.

1. **Borrowed persistence projection**
   - public constructor가 없다.
   - current sealed record 또는 닫힌 합성 commit candidate만 만들 수 있다.
   - opaque record ID, revision ID, expected revision, epoch, bucket, wire/suite와 envelope의 read-only view만 제공한다.
   - `Debug`, `Display`, `Serialize`, `Clone`, plaintext getter를 제공하지 않는다.
2. **Envelope-only rehydrate**
   - DB의 locator 컬럼을 AAD 입력으로 받지 않는다.
   - envelope를 strict decode해 private locator를 내부에서 재구성한다.
   - session commitment·epoch와 AEAD를 인증한다.
   - current inner schema만 write-capable sealed/current 타입으로 승격한다.
   - future inner/outer/suite는 원본 bytes를 가진 read-only `UpgradeRequired` 결과로 반환한다.

CAS 테스트를 위해 닫힌 합성 successor API를 추가한다. predecessor를 먼저 current session으로 인증하고, 기존 `opaque_record_id`를 유지하며 새 32-byte revision ID는 내부 CSPRNG가 생성한다. `parent_revision_id`와 expected revision은 predecessor revision으로 고정한다. caller는 ID, nonce, epoch, bucket, AAD 또는 임의 payload를 제공할 수 없다. 두 번 호출하면 같은 parent에서 갈라진 서로 다른 합성 candidate가 생성된다. 이는 제품 회전 workflow나 자유 입력 API가 아니다.

### `vault-local-store-sqlite`

이 crate는 `VaultSession`, `MasterPassword`, `OpenedCredentialV1` 또는 plaintext model을 API에 받지 않는다. 다음 opaque 책임만 가진다.

- 새 DB 생성과 schema v1 검증
- password envelope BLOB 저장·로드
- persistence projection의 immutable insert
- expected-head CAS와 conflict 보존
- bounded row 로드
- one-way 읽기 전용 보존 latch
- storage error의 비민감 코드 매핑

초기화 API는 raw password bytes 대신 current `PasswordEnvelopeStorageInspectionV1`에서 만들어진 private-field bootstrap projection을 받는다. Revision write API는 local-core의 private-constructor `CredentialCommitPersistenceProjectionV1`만 받는다.

임의 raw `(record_id, revision_id, epoch, bucket, envelope)`를 current revision으로 삽입하는 public API는 만들지 않는다. 디스크에서 읽은 raw row는 private-field `UntrustedStoredRevisionV1`이며, strict envelope inspection·column comparison·AEAD open을 통과하기 전에는 current record나 새 write의 근거가 아니다. Load type이 BLOB을 반환하는 것은 rehydrate와 exact preservation을 위한 소유권 전달뿐이며 caller-provided locator를 생성 경로로 되돌리지 못한다.

## 5. SQLite schema v1

SQLite `storage_schema_version`, crypto `wire_version`, payload `item_schema_version`, `suite_id`, `key_epoch`는 서로 다른 개념으로 유지한다. 미래 동기화의 `account_recovery_generation` 또는 checkpoint는 이번 schema에 넣지 않는다.

아래 DDL의 `record_id`는 제품 문서의 `opaque_record_id`와 1:1로 같다. 의미 있는 이름·시간·상태 컬럼은 만들지 않는다.

```sql
PRAGMA application_id = 0x53564C54; -- ASCII "SVLT"
PRAGMA user_version = 1;

CREATE TABLE vault_state (
    singleton                 INTEGER PRIMARY KEY CHECK (singleton = 1),
    password_wire_version     INTEGER NOT NULL
        CHECK (typeof(password_wire_version) = 'integer'
               AND password_wire_version BETWEEN 0 AND 4294967295),
    password_suite_id         INTEGER NOT NULL
        CHECK (typeof(password_suite_id) = 'integer'
               AND password_suite_id BETWEEN 0 AND 4294967295),
    password_envelope         BLOB NOT NULL
        CHECK (typeof(password_envelope) = 'blob'
               AND length(password_envelope) BETWEEN 1 AND 65536)
);

CREATE TABLE revisions (
    record_id                 BLOB NOT NULL
        CHECK (typeof(record_id) = 'blob' AND length(record_id) = 16),
    revision_id               BLOB NOT NULL
        CHECK (typeof(revision_id) = 'blob' AND length(revision_id) = 32),
    wire_version              INTEGER NOT NULL
        CHECK (typeof(wire_version) = 'integer'
               AND wire_version BETWEEN 0 AND 4294967295),
    suite_id                  INTEGER NOT NULL
        CHECK (typeof(suite_id) = 'integer'
               AND suite_id BETWEEN 0 AND 4294967295),
    key_epoch                 INTEGER NOT NULL
        CHECK (typeof(key_epoch) = 'integer'
               AND key_epoch BETWEEN 1 AND 4294967295),
    padding_bucket            INTEGER NOT NULL
        CHECK (typeof(padding_bucket) = 'integer'
               AND padding_bucket IN (1024, 4096, 16384, 61440)),
    envelope                  BLOB NOT NULL
        CHECK (typeof(envelope) = 'blob'
               AND length(envelope) BETWEEN 1 AND 65536),
    PRIMARY KEY (record_id, revision_id)
);

CREATE TABLE heads (
    record_id                 BLOB PRIMARY KEY
        CHECK (typeof(record_id) = 'blob' AND length(record_id) = 16),
    revision_id               BLOB NOT NULL
        CHECK (typeof(revision_id) = 'blob' AND length(revision_id) = 32),
    FOREIGN KEY (record_id, revision_id)
        REFERENCES revisions(record_id, revision_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE conflicts (
    record_id                 BLOB NOT NULL
        CHECK (typeof(record_id) = 'blob' AND length(record_id) = 16),
    candidate_revision_id     BLOB NOT NULL
        CHECK (typeof(candidate_revision_id) = 'blob'
               AND length(candidate_revision_id) = 32),
    expected_head_revision_id BLOB
        CHECK (expected_head_revision_id IS NULL
               OR (typeof(expected_head_revision_id) = 'blob'
                   AND length(expected_head_revision_id) = 32)),
    observed_head_revision_id BLOB NOT NULL
        CHECK (typeof(observed_head_revision_id) = 'blob'
               AND length(observed_head_revision_id) = 32),
    PRIMARY KEY (record_id, candidate_revision_id),
    FOREIGN KEY (record_id, candidate_revision_id)
        REFERENCES revisions(record_id, revision_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (record_id, expected_head_revision_id)
        REFERENCES revisions(record_id, revision_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (record_id, observed_head_revision_id)
        REFERENCES revisions(record_id, revision_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TRIGGER revisions_no_update
BEFORE UPDATE ON revisions
BEGIN
    SELECT RAISE(ABORT, 'immutable revisions');
END;

CREATE TRIGGER revisions_no_delete
BEFORE DELETE ON revisions
BEGIN
    SELECT RAISE(ABORT, 'immutable revisions');
END;

CREATE TRIGGER conflicts_no_update
BEFORE UPDATE ON conflicts
BEGIN
    SELECT RAISE(ABORT, 'immutable conflicts');
END;

CREATE TRIGGER conflicts_no_delete
BEFORE DELETE ON conflicts
BEGIN
    SELECT RAISE(ABORT, 'immutable conflicts');
END;
```

`revisions`와 `conflicts`의 고정 이름 trigger는 application bug에 의한 `UPDATE`와 `DELETE`를 거부한다. 이는 malicious DB editor를 막는 암호학적 장치가 아니라 구현 실수 방지 장치다. schema 검사는 `application_id`, `user_version`, application-owned object 이름 집합, `table_xinfo`, primary key, `foreign_key_list`, `index_list`와 네 trigger SQL을 checked-in golden manifest와 정해진 순서로 비교한다. 알 수 없는 application table·index·trigger를 포함해 하나라도 다르면 정상 쓰기를 시작하지 않는다.

숫자 metadata의 `typeof(...)= 'integer'` 조건은 SQLite affinity 적용 뒤 **최종 저장 storage class**를 고정한다. SQLite가 lossless하게 INTEGER로 변환하는 입력 literal의 원래 SQL 표현까지 구별하거나 거부한다고 주장하지 않는다. 구현은 숫자를 Rust 정수 parameter로 bind하고, 검증 테스트는 affinity 뒤에도 REAL/TEXT로 남는 비정수·비수치 값을 거부하는지 확인한다.

`PRAGMA application_id`는 Secure Vault 전용 `0x53564C54`(`SVLT`), `PRAGMA user_version`은 `1`로 고정한다. 더 높은 `user_version`은 downgrade하거나 새 DB로 초기화하지 않고 `UpgradeRequired` 읽기 전용 보존 상태로 연다. 알려진 하위 버전 migration은 향후 golden fixture와 원자 migration이 생기기 전에는 지원한다고 주장하지 않는다.

## 6. 연결 설정과 파일 경계

로컬 앱 전용 디렉터리의 한 DB만 열고 network share, 사용자 cloud-sync 폴더 또는 Git 작업 트리를 저장 경로로 허용하지 않는다. DB를 열기 전에 비밀을 포함하지 않는 별도 lock file의 OS exclusive lock을 얻어 한 process에 single writer만 허용한다. 쓰기는 짧은 `BEGIN IMMEDIATE` transaction만 사용하고 lock 대기는 5초 busy timeout 뒤 비민감 `Busy` 오류로 끝낸다.

기존 파일은 `no-create` read-only connection으로 먼저 연다. `application_id`, `user_version`, schema, row bounds, future/current 분류와 합성 password unlock·모든 current revision 인증이 끝나기 전에는 writable connection을 열지 않는다. wrong password, future version 또는 손상이면 read-only connection을 닫고 보존 상태만 반환한다. SQLite가 read-only WAL을 위해 만드는 일시적 `-shm` lock bookkeeping은 논리 DB write와 구분한다.

이번 alpha의 allocation·작업량 상한은 다음과 같다. 이 값은 상품 quota가 아니라 malicious/corrupt DB에 대한 로컬 안전 상한이다.

- head 5,000개
- immutable revision 10,000개
- conflict mapping 5,000개
- 모든 record envelope 합계 128 MiB
- password/record envelope 각각 65,536 bytes

각 table은 `cap + 1` 탐지 query와 opaque primary-key cursor로 한 row씩 읽는다. collection 전체 선할당, 무제한 `SELECT *`, offset pagination과 BLOB을 먼저 `Vec`으로 만든 뒤 길이를 재는 구현은 금지한다. 상한 초과는 원본을 유지한 `LimitsExceeded` 읽기 전용 보존 상태다.

Writable current DB는 다음 설정을 적용하고 반환값을 다시 확인한다.

- `journal_mode=WAL`
- `synchronous=FULL`
- `foreign_keys=ON`
- `trusted_schema=OFF`
- loadable extension 비활성화
- 지원되는 SQLite binding에서 defensive mode와 no-follow open flag 사용

WAL 전환 또는 설정 확인에 실패하면 더 약한 모드로 자동 downgrade하지 않는다. 구현 계획은 공식 registry를 다시 확인해 `rusqlite`와 bundled SQLite의 exact version·feature를 pin한다. defensive mode 또는 no-follow/equivalent path hardening을 binding이 제공하지 못하면 기능을 조용히 생략하지 않고 해당 플랫폼 구현을 차단한다. `synchronous=FULL`은 WAL commit마다 추가 sync를 수행하지만 OS, filesystem과 storage hardware가 sync 계약을 지킨다는 전제가 있다. process-crash 테스트 통과를 곧바로 모든 hardware power-loss 증명이라고 표현하지 않는다.

WAL의 `-wal`과 `-shm`은 DB 상태의 일부다. live DB의 main 파일만 복사하거나 GitHub에 올리지 않는다. 이번 단계는 backup/export API를 구현하지 않는다. 후속 backup은 SQLite Online Backup API 또는 `VACUUM INTO`로 일관된 별도 snapshot을 만든 뒤 무결성·envelope 검사를 통과해야 한다.

## 7. 열기·잠금 해제·재시작 복원 흐름

### 새 금고

1. 기존 `create_vault_v0alpha1`가 합성 password로 session과 password envelope를 만든다.
2. 존재하지 않거나 호출 시작 시 길이가 0인 파일에서만 schema, pragma 식별자와 `vault_state` singleton을 한 초기화 transaction으로 만든다. 초기화 중 실패하면 SQLite handle을 먼저 닫고, 이 호출이 만든 sidecar만 제거한 뒤 호출 전 상태를 복구한다. 호출 전 경로가 없었다면 이 호출이 만든 main 파일도 제거하고, 기존 zero-byte 파일이었다면 같은 파일을 다시 정확히 0 bytes로 만든다. 대상이 교체됐거나 호출 소유권을 확인할 수 없으면 삭제·truncate하지 않고 읽기 전용 보존 오류로 끝낸다. 각 hardening/DDL/singleton failpoint 뒤 호출 전 byte-state와 재시도 가능성을 검사한다. 기존 non-empty DB에 singleton이 없거나 일부 table만 있으면 자동 초기화하지 않고 읽기 전용 보존 모드가 된다.
3. initial synthetic commit candidate를 한 transaction으로 `revisions`와 `heads`에 기록한다.
4. session과 모든 opened model을 버리고 DB connection을 닫는다.

이번 단계는 password envelope 교체 API를 제공하지 않는다. 동일 DB 초기화 재시도는 singleton과 envelope가 byte-for-byte 같을 때만 idempotent하며, 다른 bytes면 invariant violation이다.

### 기존 금고 열기

1. OS exclusive lock을 얻고 기존 파일을 `no-create` read-only로 연다.
2. `application_id`를 먼저 확인한다. 다른 application ID 또는 non-empty `user_version=0` 파일은 v1 schema로 초기화하지 않는다.
3. `user_version`을 schema query보다 먼저 확인한다. `user_version>1`이면 v1 table을 읽지 않고 file-level `UpgradeRequired`로 끝낸다. `user_version=1`일 때만 v1 golden schema, integrity와 foreign keys를 검사한다.
4. password envelope, revision, head와 conflict row를 정해진 count/aggregate-byte 상한 아래 한 row씩 bounded load한다. BLOB은 `length()`를 먼저 확인해 65,536 bytes를 넘는 값을 Rust heap에 할당하지 않는다.
5. future-wire discriminator를 먼저 적용한다. current outer envelope만 strict full inspection으로 columns, vault commitment와 exact bytes 계약을 검증한다. schema v1 안의 future wire는 first-version field와 cached `wire_version`까지만 대조하고 나머지 locator cache를 write 근거로 사용하지 않는다.
6. 앱은 여전히 잠긴 상태다. 올바른 합성 master password가 password envelope의 Root Key를 열기 전에는 credential을 복호화하지 않는다.
7. unlock session commitment와 record commitment를 비교한 뒤 모든 current revision을 streaming 방식으로 envelope-only rehydrate·AEAD open·inner-schema validation하고 열린 item은 즉시 폐기한다. 인증된 `parent_revision_id`가 있으면 같은 record의 revision set에 실제로 존재해야 한다. 하나라도 future inner schema면 upgrade-required, 하나라도 current authentication failure나 dangling authenticated parent면 읽기 전용 보존 상태다.
8. 모든 검사를 통과한 경우에만 read-only connection을 닫고 exclusive lock을 유지한 채 `no-create` writable connection을 연다. WAL·FULL 등 writable 설정을 먼저 적용·검증한 뒤 `BEGIN IMMEDIATE`를 얻고 identity/schema/row counts와 envelope graph 검사를 transaction 안에서 다시 수행한다. preflight 이후 변화가 없음을 확인한 뒤에만 writable handle로 승격한다. 변화가 있으면 rollback하고 read-only preflight부터 다시 시작한다.
9. current head item만 메모리 관계 지도로 승격한다. 잠금 시 opened model과 검색용 메모리를 제거한다.

이 흐름은 **재시작 복원**이다. 오프라인 복구 키, recovery Key Slot, 신뢰 기기 또는 전역 `복구 사건`을 구현하지 않는다.

Wrong master password는 DB 손상으로 분류하지 않는다. writable connection을 열지 않고 잠긴 상태와 DB bytes를 그대로 유지한 채 일반 인증 실패만 반환한다.

## 8. revision commit와 충돌 규칙

모든 commit은 다음 순서를 하나의 `BEGIN IMMEDIATE` transaction 안에서 수행한다.

1. projection과 envelope metadata가 current wire/suite이고 서로 정확히 일치하는지 확인한다. candidate의 inspected vault commitment가 `vault_state` password envelope commitment와 다르면 어떤 row도 쓰지 않고 non-latching `WrongVaultCandidate`를 반환한다. 기존 DB가 아니라 들어온 candidate가 다른 금고 소속인 것이므로 저장소 손상으로 분류하지 않는다.
2. 같은 `(record_id, revision_id)`가 이미 있는지 **base/head 검사와 CAS보다 먼저** 확인한다.
   - stored fields와 envelope 중 하나라도 다르면 ID collision 또는 immutability violation으로 transaction을 중단하고 읽기 전용 보존 상태로 전환한다.
   - byte-for-byte 같고 기존 conflict mapping이 있으면 candidate의 expected가 그 mapping과 같은지만 확인한다. 다르면 base 존재 여부를 보기 전에 invariant violation이다. 같으면 현재 head와 무관하게 원래 mapping을 그대로 두고 `ConflictPreserved`를 반환하며 최초 observed head를 갱신하지 않는다.
   - byte-for-byte 같고 conflict mapping이 없으면 현재 head가 더 진행됐더라도 `AlreadyCommitted`를 반환한다. atomic transaction 계약상 이는 과거 또는 현재 canonical revision이다. canonical revision에는 원래 expected를 저장하지 않으므로 retry가 가져온 expected의 동일성을 증명한다고 주장하지 않으며, 그 값 때문에 새 conflict나 write를 만들지 않는다.
3. primary key가 **새 candidate**이고 `expected_revision_id`가 있으면 같은 `record_id`의 base revision과 canonical head가 모두 존재해야 한다. 하나라도 없으면 candidate를 insert하지 않고 non-latching `MissingBase`로 전체 rollback한다.
4. primary key가 없는 새 revision에만 immutable row를 insert하고 head CAS를 수행한다.
   - initial candidate는 expected와 head가 모두 없으면 새 head가 된다.
   - initial candidate인데 같은 record의 head가 이미 있으면 head를 유지하고 candidate를 conflict로 보존한다.
   - successor의 expected와 head가 같으면 head를 candidate revision으로 바꾼다.
   - successor의 expected base는 존재하지만 현재 head가 다르면 head를 유지하고 candidate와 최초 expected/observed head를 `conflicts`에 기록한다.
5. commit 성공 뒤 `Committed`, `AlreadyCommitted` 또는 `ConflictPreserved` 비민감 outcome을 반환한다.

Conflict는 정상적인 동시성 결과다. LWW, 문자열 merge, 자동 삭제 또는 candidate 덮어쓰기를 하지 않는다. 이번 단계에는 conflict resolution, rotation cutover, tombstone 또는 GC가 없으므로 revision·conflict 물리 삭제 API를 제공하지 않는다.

동일 candidate의 conflict retry는 head가 바뀐 뒤에도 idempotent하다. 기존 conflict mapping이 있는 같은 candidate bytes로 다른 expected가 나오면 invariant violation이지만, 현재 observed head가 최초 mapping과 달라진 것은 정상 head 진행이므로 비교·갱신하지 않는다. conflict mapping이 없는 canonical retry는 expected를 보존하지 않으므로 동일성을 검증한다고 주장하지 않고 무쓰기 `AlreadyCommitted`로 끝낸다.

same-PK persistent bytes 불일치 또는 private projection/envelope metadata 불일치는 transaction을 rollback한 뒤 해당 writable handle을 one-way 읽기 전용 보존 latch로 전환한다. trigger가 된 호출과 이후 `commit`은 안정적인 `InvariantViolation`만 반환하고 DB query/write를 더 수행하지 않는다. `WrongVaultCandidate`와 `MissingBase`는 candidate 입력 문제이므로 latch하지 않으며 이후 정상 commit을 허용한다. latch는 DB row가 아니라 process-memory handle 상태다.

## 9. future version·손상·보존 상태

`UpgradeRequired`와 손상은 구분한다.

### Upgrade-required 읽기 전용 상태

- 더 높은 SQLite `user_version` — v1 schema fingerprint나 typed row query를 실행하지 않는 file-level 상태
- canonical하지만 지원하지 않는 password/record wire 또는 suite
- 인증에 성공했지만 더 높은 item schema

원본 password/record BLOB과 DB row를 byte-for-byte 보존한다. `user_version>1`에서는 v1 table layout을 가정하지 않으므로 어떤 record도 읽지 않는다. storage schema v1 안에서 bounded future-wire discriminator 또는 authenticated future inner schema만 발견된 경우에는 알려진 current record를 가능한 범위에서 읽을 수 있다. 두 경우 모두 store 전체의 새 commit, CAS, migration과 자동 초기화를 막으며 구버전 writer가 미래 record를 덮어쓰면 안 된다.

Storage schema v1이 보존할 수 있는 future outer wire는 65,536-byte 상한, first canonical unsigned version과 legacy cache column 계약을 지키는 경우다. 새 wire가 이 prefix나 cache를 제거해야 한다면 새 writer는 `user_version`도 올려 file-level 보존 경로를 사용해야 한다. 임의의 모든 미래 형식을 v1 reader가 이해하거나 진위 검증한다고 약속하지 않는다.

### 읽기 전용 보존 모드

다음은 current 계약의 손상 또는 invariant violation이다.

- `integrity_check` 또는 `foreign_key_check` 실패
- schema fingerprint, column width/range 또는 current envelope/column 불일치
- password envelope commitment와 current record commitment 불일치
- correct session 뒤 current record AEAD authentication 실패
- same primary key에 다른 bytes 또는 dangling head

손상 record는 원본 그대로 논리적으로 격리하고, 보수적인 `v0alpha1` 정책으로 store 전체의 추가 쓰기를 중단한다. 가능한 정상 record 읽기와 raw ciphertext 보존은 허용하지만 자동 수정·삭제·덮어쓰기·새 빈 vault 초기화는 하지 않는다. 이 명칭은 아직 미구현인 제품 `복구 사건`과 구분하기 위해 `복구 모드`가 아니라 **읽기 전용 보존 모드**로 고정한다.

SQLite error, path, SQL parameter, opaque ID, envelope, ciphertext 또는 사용자 필드를 로그·panic·analytics·crash report에 넣지 않는다. public error는 `Busy`, `Io`, `SchemaUpgradeRequired`, `CorruptStorage`, `InvariantViolation`, `LimitsExceeded`, `WrongVaultCandidate`, `MissingBase`처럼 안정적인 비민감 code만 제공한다. envelope-bearing type은 blanket `Debug`, `Display`, `Serialize`, `Clone`을 갖지 않는다.

## 10. 롤백·누락 한계

이번 로컬 CAS는 정상 API를 사용하는 stale writer를 막지만 freshness proof는 아니다. current `v0alpha1`에는 signed event, authenticated 전체 manifest, checkpoint chain 또는 OS monotonic anchor가 없다. 따라서 공격자가 DB와 WAL을 함께 다음과 같이 교체하면 탐지하지 못할 수 있다.

- 과거의 정상 DB snapshot 전체 복원
- canonical head를 과거의 유효 revision으로 되돌림
- 논리 record와 그 revision row 전체 누락

이를 탐지한다고 주장하지 않는다. 후속 sync/event/checkpoint ADR이 signed manifest를 만들고, 마지막 trusted checkpoint hash/sequence를 기기 보호 저장소 또는 독립 witness에 고정해야 rollback/replay 보장이 시작된다.

따라서 현재 단계는 `THREAT_MODEL.md`의 “기존 신뢰 기기는 rollback, replay, 누락, 재정렬을 탐지해야 한다”는 불변조건을 아직 충족하지 않는다. 이 조건과 recovery/device gate가 구현·검토되기 전에는 실제 Secret 지원을 계속 차단한다.

## 11. crash·corruption·backup 동작

- revision insert, head CAS와 conflict insert는 반드시 같은 transaction이다.
- parent test process가 child writer를 `COMMIT` 전에 종료하면 candidate와 head가 모두 보이지 않아야 한다.
- `synchronous=FULL` commit 반환 뒤 child를 종료하면 revision과 head가 함께 보여야 한다.
- stale writer 경로도 `COMMIT` 전 종료에서는 revision/conflict가 모두 없고 head가 그대로이며, commit 뒤에는 revision/conflict가 함께 있고 head가 그대로여야 한다.
- 이 테스트는 process termination atomicity를 검증한다. storage가 sync 요청을 거짓 보고하거나 hardware가 순서를 위반하는 상황까지 증명하지 않는다.
- SQLite logical integrity와 record AEAD authenticity를 별도로 검사한다. 하나의 검사를 다른 검사의 증거로 사용하지 않는다.
- 손상 원본을 같은 DB 안의 quarantine table로 자동 이동하지 않는다. 손상 DB에 추가 write를 만들지 않고 in-memory 진단 상태와 후속 read-only export 대상으로만 분류한다.
- live WAL DB의 main file 단순 복사는 지원 backup이 아니다.

## 12. 검증 기준

모든 fixture는 `DEMO_VALUE_ONLY_`, `.invalid`와 명백한 합성 이름만 사용한다.

### 저장과 재시작

- create → seal → DB commit → session drop → DB close → reopen → unlock → envelope-only rehydrate → authenticated open으로 같은 provider와 connection count를 복원한다.
- 재시작 직후에는 잠긴 상태이며 wrong password 뒤 writable connection과 application write transaction이 생기지 않고 password/record envelope, revision graph와 head의 논리 값이 바뀌지 않는다. 기존 main DB와 `-wal`은 hash가 유지되어야 하며 일시적 `-shm` lock bookkeeping은 별도로 취급한다.
- DB, `-wal`, `-shm`, rollback journal, 임시 backup 후보 전체에서 합성 provider/account/project/Secret/note marker를 raw scan해 평문이 없음을 확인한다.
- 검색어와 파생 검색·관계 index를 나타내는 합성 marker도 어떤 저장 파일에 나타나지 않아야 한다.
- row count와 envelope byte 상한은 `cap`, `cap + 1`, zero-length, oversized case로 검사하고 load가 한 row씩 bounded하게 진행되는지 확인한다.

### CAS와 immutable history

- correct expected head만 canonical head를 전진시킨다.
- 같은 predecessor에서 만든 두 CSPRNG successor 중 하나가 이기고 stale candidate는 conflict ciphertext로 남는다.
- committed candidate를 head가 한 번 더 전진한 뒤 재시도해도 `AlreadyCommitted`이고 새 conflict를 만들지 않는다.
- conflict candidate를 head가 한 번 더 전진한 뒤 재시도해도 최초 mapping을 유지한 `ConflictPreserved`이며 invariant violation이 아니다.
- same `(record_id, revision_id)`와 다른 BLOB은 overwrite되지 않고 invariant violation이 된다.
- 다른 vault의 valid candidate는 어떤 row도 쓰지 않는 `WrongVaultCandidate`이며 기존 store를 read-only latch하지 않는다.
- 존재하지 않는 expected base 또는 head 없는 successor는 어떤 row도 쓰지 않는 `MissingBase`다.
- authenticated inner `parent_revision_id`가 같은 record의 저장 revision에 없으면 정상 writable 상태로 승격하지 않는다.
- dangling head, missing revision과 modified immutable trigger/schema를 정상 상태로 열지 않는다.

### crash와 corruption

- subprocess/failpoint로 commit 전·후 process termination을 재현해 revision/head의 원자성을 증명한다.
- DB column, outer header, nonce, wrapped Item DEK, body ciphertext, trailing byte, noncanonical CBOR와 oversized BLOB 변조를 각각 검사한다.
- current row의 column만 바꾸어도 envelope-derived metadata mismatch로 읽기 전용 보존 모드가 된다.
- 다른 vault의 valid envelope와 epoch swap은 거부된다.
- corruption에서 원본 row가 자동 수정·삭제·overwrite되지 않는다.

### future와 migration

- first version만 보존하고 field count·unknown tail을 바꾼 두 future outer wire fixture와 authenticated future inner schema BLOB은 close/reopen 전후 exact bytes가 같고 `UpgradeRequired`가 되며 CAS할 수 없다.
- 더 높은 storage schema는 v1 table query·fingerprint보다 먼저 감지하고 downgrade하거나 빈 v1 DB로 바꾸지 않는다.
- wrong password, future crypto와 higher storage schema, corruption preflight가 writable connection을 열지 않고 기존 main/`-wal` hash와 논리 row를 보존하는지 각각 검사한다.
- schema v1 golden DDL, application ID, `user_version`, trigger와 foreign-key validation을 테스트한다.
- Android 후속 adapter가 같은 BLOB/INTEGER schema를 표현할 수 있음을 DDL contract test로 확인하되 Room 구현·기기 테스트를 이번 완료로 계산하지 않는다.

### API와 회귀

- projection, sealed/current/future-preserved type 직접 생성, ID constructor와 caller entropy/AAD/nonce 입력은 compile-fail이다.
- opened secret와 envelope-bearing type에 금지된 trait·getter가 생기지 않는다.
- store crate에 plaintext model, network, process execution, clipboard 또는 browser code가 없음을 확인한다.
- 기존 `vault-crypto`/`vault-local-core` 전체 test, trybuild, vectors, fmt와 Clippy가 계속 통과한다.
- regression 통과를 독립 암호 검토 또는 실제 Secret 출시 승인으로 표현하지 않는다.

## 13. 이번 단계의 명시적 비범위

- 실제 자격 증명, 자유 입력, paste/import
- 검색·관계 인덱스와 60초 재인증 UI
- 실제 rotation workflow, 외부 자격 증명 폐기와 connection checklist
- tombstone, delete conflict와 GC
- outbox, network, server sync, signed event/checkpoint와 device signature
- backup/export UI와 평문 export
- recovery Key Slot, 신뢰 기기, 생체 인증과 key epoch rotation
- Android Room/Keystore/BiometricPrompt와 Web UI
- SQLCipher
- 결제, quota와 구독
- 브라우저 확장, CLI, MCP 실행과 AI/플러그인의 금고 접근
- 실제 Secret 공개 베타

## 14. 후속 순서

1. 이 명세의 상세 구현 계획과 task별 TDD gate
2. 합성 ciphertext-only SQLite adapter 구현·독립 review·GitHub branch backup
3. in-memory 관계 검색, 최근 재인증 gate와 합성 rotation candidate workflow
4. synthetic-only Android fixture UI와 SQLite adapter 통합
5. recovery Key Slot wire ADR, Android hardware-backed 기기 키 ADR와 합성 복구 상태기계
6. append-only sync event/checkpoint ADR와 rollback anchor
7. 외부 독립 암호 설계·구현 검토, 침투 테스트와 복구 훈련
8. 모든 출시 차단 gate를 통과한 뒤에만 실제 Secret 지원 결정

## 15. 공식 참고자료

- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [SQLite PRAGMA synchronous·integrity_check](https://www.sqlite.org/pragma.html)
- [SQLite Atomic Commit](https://www.sqlite.org/atomiccommit.html)
- [SQLite Online Backup API](https://www.sqlite.org/backup.html)
- [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuuminto)
