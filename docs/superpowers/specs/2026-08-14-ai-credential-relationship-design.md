# AI 자격 증명·MCP 연결 지도 설계

- 상태: 사용자 승인
- 기준일: 2026-08-14
- 적용 제품: Secure Vault 웹·모바일 금고와 향후 로컬 확장 도구
- 첫 구현 원칙: 수동 등록 우선, 합성 데이터 전용

## 1. 제품 정체성

Secure Vault는 단순 비밀번호 목록이 아니라 **AI 시대의 API 키·MCP 연결 관계 금고**다. 사용자가 어느 서비스 Console에서 어떤 자격 증명을 발급했고, 어떤 앱·플러그인·MCP 서버·프로젝트·환경에 연결했는지를 한곳에서 찾고 회전할 수 있게 한다.

대표 관계는 다음과 같다.

```text
OpenAI Console
  -> 개인 계정 / 조직 / 프로젝트
  -> API Key A
  -> Cursor, 로컬 MCP 서버, Vercel 프로젝트
```

API Key A를 폐기하거나 교체하면 연결된 세 위치를 모두 갱신해야 한다는 체크리스트를 제공한다. 금고는 키의 원문 보관뿐 아니라 출처, 사용처, 권한, 만료와 회전 상태를 함께 관리한다.

## 2. 성공 기준

첫 사용 가능 버전은 합성 데이터로 다음 흐름을 완주한다.

1. 합성 fixture에서 서비스와 Console 출처 선택
2. 합성 계정·조직·프로젝트·환경 선택
3. 합성 자격 증명을 안전한 입력 화면에서 저장
4. 자격 증명의 연결처를 기록하거나 `아직 연결 안 함`으로 저장
5. 서비스명·프로젝트·환경·연결처로 로컬 검색
6. 회전 시작 시 모든 연결처 체크리스트 생성
7. 각 연결처의 갱신 완료를 표시하고 이전 키를 폐기
8. 잠금과 앱 재실행 뒤 암호문에서 같은 관계 지도를 복구

실제 비밀번호·API 키 지원은 복구·기기 키 구현과 외부 독립 보안 검토 이후의 별도 출시 게이트다.

## 3. 단계별 범위

### 첫 단계: 수동 등록

모든 서비스에서 공통으로 동작하고 브라우저 페이지 권한을 요구하지 않으므로 채택한다. 서비스 템플릿은 입력을 줄이지만, 사용자가 저장 버튼을 누르기 전에는 어떤 값도 캡처하지 않는다.

### 다음 단계: 브라우저 확장과 로컬 CLI

금고 코어와 수동 흐름이 검증된 뒤 별도 위협 모델로 추가한다. 확장은 사용자가 명시적으로 누른 현재 탭에서만 동작하고, 공급자 allowlist, 최소 권한, 로컬 암호화와 짧은 메모리 수명을 적용한다. CLI는 Secret을 stdout, shell history, process argument나 로그로 출력하지 않는 로컬 IPC 방식만 검토한다.

### 제외: 전체 계정 자동 발견

공급자마다 API, 권한과 키 표시 정책이 다르고 일부 키는 발급 순간에만 원문을 보여 준다. 첫 버전은 사용자의 모든 계정과 연결처를 자동으로 발견했다고 주장하지 않는다. 공식 공급자 API가 있고 사용자가 범위를 승인한 커넥터만 이후 개별 설계한다.

## 4. 암호화 경계와 데이터 모델

첫 버전은 **암호화 레코드 하나가 자격 증명 하나와 그 연결 목록을 소유**한다. 수백 개 규모에서 이해와 복구가 단순하고, 서버가 별도 평문 관계 테이블을 볼 필요가 없다. 잠금 해제된 클라이언트가 레코드들을 복호화해 메모리에서 연결 지도를 만든다.

### 외부 envelope

합성 로컬 알파는 기존 `record-envelope-v0alpha1`의 다음 필드를 암호문 밖에 둔다.

- `wire_version`, `suite_id`
- `vault_commitment`
- `opaque_record_id`, `revision_id`
- `key_epoch`, `padding_bucket`
- Item DEK wrap nonce·ciphertext
- body nonce·ciphertext

기존 AAD 계약이 지정한 context 필드는 canonical encoding으로 인증되고, nonce와 ciphertext는 선택된 AEAD 연산에 결합된다. suite, nonce와 padding은 기존 CDDL 계약을 따른다. 서버 또는 로컬 저장소는 레코드 수, envelope byte, opaque ID, revision·epoch와 변경 패턴을 볼 수 있다. 자격 증명의 의미는 알 수 없어야 한다.

`v0alpha1`에는 동기화 parent DAG와 기기 서명이 없으므로 로컬 저장 전용이다. 로컬 DB는 `(opaque_record_id, expected_revision_id)` compare-and-swap으로 현재 head를 바꾸고, inner payload에 직전 revision ID를 넣는다. 전체 DB를 과거의 유효 상태로 되돌리는 공격은 아직 탐지할 수 없다고 명시한다. 다중 기기 동기화 전 새 event wire ADR이 `parent_head_hash` 또는 parent IDs, device ID·sequence, 이전 event hash, signature와 checkpoint binding을 외부 authenticated envelope에 추가해야 한다.

### `CredentialItemV1` 암호화 payload

- `item_schema_version`
- `parent_revision_id` — 최초 revision은 없음
- `item_name`
- `provider_template_id` — 공개 정적 템플릿을 선택한 경우의 ID이지만 payload 안에서 암호화
- `provider_name`
- `console_url`
- `issuer_account_ref`, `issuer_project_ref` — Rust 코어가 만든 안정적인 로컬 UUID, 선택
- `issuer_account_identifier`
- `issuer_organization_or_workspace`
- `issuer_project`
- `issuer_environment`
- `credential_type` — password, api_key, oauth_client, cloud_access_key, token, recovery_code, custom
- `secret_fields[]`
- `display_hint` — 타입별 정책으로 클라이언트가 생성, 사용자 직접 입력 금지
- `scopes_or_permissions`
- `issued_at`, `expires_at`, `rotate_at`
- `timestamp_provenance` — user_entered, provider_verified, imported_fixture
- `status` — active, rotation_due, rotating, expired, compromised, revoked, disabled, unknown
- `external_revocation_status` — not_requested, pending, user_confirmed, provider_verified, failed, unknown
- `external_revocation_attestation` — none, user, provider_connector
- `revoked_at`
- `rotation_state` — 선택 필드. 이 revision이 회전을 완료할 때 대체한 직전 revision과 그 외부 폐기 결과
- `connections[]`
- `tags`, `notes`
- `created_at`, `updated_at`

### `SecretFieldV1`

하나의 자격 증명이 여러 값을 가질 수 있게 한다. 예를 들어 OAuth client ID·secret, AWS access key ID·secret·session token을 한 항목으로 관리한다.

- `field_id`, `label`
- `field_role` — identifier, secret, token, configuration
- `sensitivity` — public_identifier, private_metadata, secret
- `value`
- `reveal_policy` — masked, reveal_after_reauth
- `copy_policy` — allowed_after_reauth, never

MCP 서버 설정은 `credential_type`이 아니다. MCP는 연결처 또는 통합 설정이며, MCP가 사용하는 토큰·OAuth·API 키를 Credential로 참조한다.

### `ConnectionV1`

- `connection_id`
- `consumer_type` — app, browser_extension, plugin, mcp_server, cli, server, ci_cd, cloud_project, custom
- `consumer_name`
- `consumer_project`
- `consumer_environment`
- `purpose`
- `configuration_reference` — 사용자가 이해할 위치 설명; Secret 원문과 실행 명령 금지
- `credential_alias_or_env_name`
- `required_for_cutover` — 기본값 true
- `status` — connected, update_required, verified, removed, unknown
- `verification_source` — user, provider_connector, none
- `last_verified_at`
- `notes`

`consumer_type=mcp_server`이면 다음 `McpIntegrationV1`을 선택적으로 포함한다.

- `transport` — stdio, streamable_http, sse, custom
- `server_identifier`
- `package_or_executable_reference` — 기록용 텍스트; 실행 금지
- `argument_template` — Secret 원문 금지, 기록용 텍스트
- `endpoint_url`
- `credential_field_bindings[]` — 환경 변수·설정 키 이름과 `SecretFieldV1.field_id` 참조
- `configuration_location`
- `execution_policy` — V1에서는 항상 record_only

MCP typed config는 연결 관계를 설명하기 위한 데이터다. V1 UI는 command·package·argument를 실행하거나 자동 복사하지 않는다.

### `RotationStateV1`

- `supersedes_revision_id`
- `required_connection_ids[]`
- `completed_connection_ids[]`
- `superseded_external_revocation_status`
- `superseded_external_revocation_attestation`
- `superseded_revoked_at`

과거 revision은 immutable이며 그 payload의 `active` 값을 수정하지 않는다. 현재 head의 `RotationStateV1`과 revision chain에서 과거 revision의 유효 상태를 파생한다.

참조 무결성은 암호화하기 전에 검증한다. `credential_field_bindings[].field_id`는 같은 항목의 실제 `SecretFieldV1.field_id`만 가리키고 binding 이름과 참조 쌍은 중복될 수 없다. 회전 완료 revision의 `supersedes_revision_id`는 그 revision의 `parent_revision_id`와 같아야 한다. `required_connection_ids`는 같은 payload에서 `required_for_cutover=true`이고 제거되지 않은 연결처 ID 집합과 정확히 같고, `completed_connection_ids`는 그 부분집합이다. 선택 연결처의 완료 여부는 각 `ConnectionV1.status`로 표시하며 cutover를 막지는 않지만 미완료 경고를 유지한다. `superseded_revoked_at`은 외부 폐기 상태가 `user_confirmed` 또는 `provider_verified`이고 해당 attestation이 있을 때만 존재한다. dangling·self·중복 reference와 상태 불일치는 인증된 payload라도 malformed로 거부한다.

V1은 공급자·계정 표시값을 자격 증명마다 의도적으로 비정규화해 오프라인 복구를 단순화한다. `issuer_account_ref`와 `issuer_project_ref`가 같은 항목끼리 로컬 UI에서 묶지만, 이름이 비슷하다는 이유로 자동 병합하지 않는다. 사용자가 병합하면 각 논리 항목에 새 head revision을 만들고 새 reference를 기록하며 과거 revision은 변경하지 않는다.

모든 시간은 RFC 3339 UTC로 저장하고 provenance를 함께 표시한다. `display_hint`는 기본적으로 타입별 허용 prefix와 마지막 네 문자 이내만 사용하고 최대 32 UTF-8 bytes이며, 사용자가 끌 수 있다. 힌트도 서버에는 암호문으로만 저장한다.

제품 payload 상한은 canonical encoding 기준 60,000 bytes다. `item_name`은 1~128 bytes, 일반 표시 필드는 각각 최대 256 bytes, URL은 최대 2,048 bytes, `secret_fields`는 최대 16개·값 합계 32 KiB, `connections`는 최대 128개, 태그는 최대 32개·각 64 bytes, notes는 최대 8 KiB다. 현재 `item_schema_version`의 알 수 없는 enum·field, 중복 ID, 제한 초과와 non-canonical payload는 malformed로 거부한다. 알 수 없는 미래 schema·wire version은 손상으로 단정하지 않고 원본 ciphertext를 그대로 보존한 채 `업그레이드 필요` 읽기 전용 상태로 표시하며 구버전 클라이언트가 덮어쓰지 못하게 한다.

서비스명, 계정, URL, 프로젝트, 연결처, 별칭, 태그, 메모와 시간은 모두 의미 있는 콘텐츠 메타데이터이므로 Secret 원문과 같은 암호화 payload 안에 둔다. 서버 검색용 blind index는 첫 버전에 만들지 않는다. Secret 원문은 로컬 검색 인덱스의 대상이 아니다. ID와 revision은 UI가 임의 바이트로 만들지 않고 Rust 로컬 코어의 CSPRNG가 생성한다.

| 서버·저장소가 관찰할 수 있음 | 암호화 payload 안에 있음 |
| --- | --- |
| opaque record·revision ID, key epoch | 서비스·Console·계정·프로젝트·환경 |
| envelope·padding byte와 레코드 수 | 자격 증명 종류, 모든 Secret field와 hint |
| revision·요청 시각과 접근 패턴 | 연결처 수·이름·상태, 태그·메모 |

검색어는 payload에도 저장하지 않고 잠금 해제된 클라이언트 메모리에만 존재하며 로그·분석·동기화에서 제외한다. padding bucket은 정확한 길이를 숨기지만 bucket과 변경 패턴에 따른 추정 가능성은 남는다.

## 5. 수동 등록 흐름

화면당 주 행동 하나를 사용한다.

1. `어디에서 발급했나요?` — 서비스와 Console
2. `어느 계정·프로젝트인가요?` — 계정, 조직, 프로젝트, 환경
3. `무엇을 발급했나요?` — 종류, 합성 Secret, 권한, 만료
4. `어디에 연결했나요?` — 소비자 0개 이상 또는 `아직 연결 안 함`
5. 저장 결과와 연결 지도 확인

출시 제품의 필수 입력은 서비스, 자격 증명 종류, 항목 이름, 하나 이상의 Secret field로 제한하고 나머지는 `자세히 입력`에 접는다. 계획된 합성 전용 UI는 자유 입력을 제공하지 않고 서비스, 계정, 프로젝트, URL, 메모, 연결처와 Secret을 빌드에 포함된 합성 fixture·template에서만 선택하게 한다. 이 UI는 아직 구현되지 않았다. 붙여넣기, import, deep link, CLI, 확장 메시지와 임의 텍스트 입력은 `synthetic-only` 빌드에서 fail-closed로 비활성화한다.

목록의 기본 카드에는 서비스, 항목 이름, 환경, 상태와 연결처 수만 표시한다. 상세 화면에서 연결처를 펼친다. 각 `SecretFieldV1`의 reveal·copy policy를 적용하고, Secret 보기·복사는 60초 이내의 최근 재인증 뒤에만 허용한다. 재인증 취소·실패·만료 또는 앱 백그라운드 전환은 승인을 즉시 무효화한다. 잠금 시 복호화 목록과 검색·관계 인덱스를 제거한다.

Console URL은 기본적으로 plain text로 렌더링한다. 링크 열기는 정규화된 `https` URL만 허용하고 대상 origin을 다시 보여 준 뒤 외부 이동을 확인받으며 `noopener`, `noreferrer`를 사용한다. 원격 favicon과 preview를 요청하지 않는다. 이름, notes와 configuration reference는 HTML·Markdown으로 실행하지 않고 plain text로 표시하며, `javascript:`, `file:`, shell command와 제어 문자를 실행 경로에 넘기지 않는다.

## 6. 회전과 폐기

회전은 기존 값을 즉시 덮어쓰지 않고 새 immutable revision으로 시작한다. 각 revision은 직전 head를 parent로 참조하며 로컬 저장소는 expected head compare-and-swap으로 하나의 canonical head만 확정한다. 동시에 갈라진 revision은 어느 쪽도 버리지 않고 충돌 복구함에서 사용자가 해결한다.

1. 새 자격 증명 생성 또는 입력
2. 기존 연결 목록을 `update_required`로 복제
3. 연결처별 갱신과 검증
4. `required_for_cutover=true`인 모든 연결처가 완료된 뒤 외부 Console 폐기 확인. 선택 연결처만 미완료이면 경고를 유지하되 cutover는 허용
5. provider connector 증거가 있으면 `provider_verified`, 없으면 사용자의 명시 확인을 `user_confirmed`로 기록
6. 새 revision을 canonical `active` head로 확정하고, 새 head의 `RotationStateV1`에 이전 revision의 유효 폐기 상태와 시각을 기록

사용자가 연결처를 빠뜨렸을 수 있으므로 `모든 사용처를 자동 발견했다`고 표시하지 않는다. 마지막 확인 시 `내가 기록한 연결처 기준`이라고 명시한다. 연결 확인일이 오래되면 `unknown` 또는 `확인 필요` 상태를 보여 준다.

분실 기기나 복구 수단 침해 뒤에는 연결 지도를 이용해 실제 외부 서비스의 자격 증명 회전 목록을 만든다. 앱 내부 key epoch 교체가 이미 외부 공급자에게 발급된 API 키를 자동 폐기한다고 오해하게 해서는 안 된다.

## 7. 웹·확장·MCP 경계

### 금고 웹앱

별도 vault origin에서 실행하며 광고, 행동 분석, 채팅 위젯과 제3자 태그를 넣지 않는다. 공개 블로그와 AdSense는 다른 origin·runtime·배포 파이프라인을 사용한다. 웹앱은 암호문만 IndexedDB에 저장하고 검색·관계 지도는 잠금 해제 중 메모리에서 만든다.

그러나 잠금 해제 중 JavaScript·WASM과 DOM은 평문을 다루므로 웹 배포 서버, service worker, 브라우저 확장과 의존성 공급망은 고위험 신뢰 경계다. 실제 Secret 웹 지원 전 다음을 모두 검증한다.

- 사용자 입력을 plain text로 렌더링하고 stored XSS·URL·Markdown injection 차단
- nonce 기반 엄격한 CSP, Trusted Types와 허용된 자체 API 외 `connect-src` egress 차단
- 원격 폰트·favicon·이미지·제3자 asset 요청 금지
- lockfile·dependency digest 고정, 공급망 검토와 재현 가능한 release build
- service worker의 범위·업데이트 무결성·캐시 삭제 정책
- 배포 서버가 악성 JavaScript를 제공하면 평문 탈취가 가능하다는 한계 공개

서명된 Android 앱을 첫 고보증 클라이언트로 삼고, 웹 실제 Secret 지원은 별도 출시 결정을 통과할 때만 활성화한다.

### 브라우저 확장

첫 구현 범위에서 제외한다. 이후에는 `activeTab` 또는 선택적 공급자별 host permission만 사용하고, 사용자가 누른 `이 키를 금고에 저장` 동작에만 반응한다. 정확한 origin과 캡처 예정 필드를 preview하고 사용자가 승인해야 한다. 배경 DOM 수집, 클립보드 감시, 모든 사이트 권한, background network permission과 자동 전송을 금지한다.

확장과 로컬 금고 채널은 상호 인증된 일회성 challenge, nonce, 짧은 TTL과 replay cache를 사용한다. 피싱 origin, 변조된 공급자 페이지와 spoofed local receiver를 threat model에 포함한다. 원문은 로컬 금고 클라이언트로 직접 전달하고 중간 서버나 분석 SDK를 거치지 않는다.

### 로컬 CLI와 MCP 도구

초기 MCP 정보는 이름, transport, command·package·URL, 환경 변수 이름과 Credential 참조를 기록하는 데이터일 뿐 임의 명령을 실행하지 않는다. 향후 로컬 주입 도구는 목적지 executable identity·서명 또는 command hash allowlist를 확인하고, 사용자가 목적지·Credential alias·scope를 매번 승인한 단회 lease만 발급한다. lease는 짧은 TTL과 한 번의 사용 뒤 폐기되며 파일·로그·명령줄·모델 prompt·tool result에 원문을 남기지 않는다. 승인된 대상 프로세스가 받은 Secret을 이후 유출할 수 있다는 한계는 제거할 수 없다.

AI 모델과 공개 OpenAI 플러그인에는 비밀번호, API 키, Secret 원문을 전달하지 않는다. `어디에서 발급했고 어디에 연결했는지` 같은 의미 메타데이터도 사용자가 승인한 별도 AI projection 설계 전에는 모델로 보내지 않는다. 일반 보안 가이드 플러그인과 실제 금고 접근 플러그인을 같은 것으로 취급하지 않는다.

## 8. 오류와 안전 동작

- 저장 실패 시 입력 원문을 로그에 남기지 않고 암호화 레코드와 로컬 outbox를 원자적으로 처리한다. outbox에는 ciphertext와 허용된 opaque envelope만 저장하며 입력 DTO 평문을 넣지 않는다.
- 손상된 레코드는 자동 수정·덮어쓰기하지 않고 원본 암호문을 격리한다.
- 잘못된 비밀번호와 인증 실패는 평문 일부를 포함하지 않는 일반 오류로 표시한다.
- 연결처 삭제와 자격 증명 회전이 충돌하면 두 revision을 보존하고 사용자가 해결한다.
- Secret, 검색어, Console URL과 configuration reference를 URL query, analytics, crash report에 넣지 않는다.
- 복사한 Secret의 클립보드 자동 삭제는 가능한 플랫폼에서 시도하되 OS 보장을 과장하지 않는다.
- 브라우저·JavaScript 메모리의 완전 zeroization을 보장한다고 표현하지 않는다.

## 9. 검증 기준

합성 데이터로 다음을 통과해야 한다.

- 한 자격 증명에 0개·1개·여러 연결처를 저장하고 다시 복구
- 서비스·프로젝트·환경·연결처 검색 결과 재구성
- 앱 재실행 뒤 잠금 상태 유지와 암호문만 저장됨
- 회전 중 모든 기록된 연결처가 `update_required`가 됨
- 필수 연결처 하나라도 미완료이면 이전 키 폐기 완료로 표시하지 않음
- 필수 연결처는 모두 완료되고 선택 연결처만 미완료이면 경고를 유지하면서 cutover를 허용
- 동시 회전에서 어느 Secret revision도 조용히 사라지지 않음
- 손상된 레코드, 잘못된 비밀번호와 문맥 교체 거부
- 로그, 오류, URL, IndexedDB 평문 검사에서 Secret과 의미 메타데이터가 없음
- 로컬 관계 인덱스를 삭제해도 암호화 레코드에서 동일한 연결 지도를 재생성
- 공개 플러그인과 AI 모델 경로로 Secret 또는 관계 메타데이터가 전달되지 않음
- schema migration, 알 수 없는 enum·필드, 길이·개수 상한과 malformed·fuzz payload 거부
- dangling·self·중복 reference, 잘못된 field binding, 회전 parent 불일치, 완료 집합이 필수 집합을 벗어나는 payload 거부
- 알 수 없는 미래 schema·wire version의 ciphertext는 손상 처리나 덮어쓰기 없이 보존되고 `업그레이드 필요` 읽기 전용 상태가 됨
- stored XSS, HTML·Markdown·URL scheme·제어문자 injection이 실행되지 않음
- CSP·Trusted Types를 우회한 외부 egress와 원격 asset 요청이 없음
- localStorage, sessionStorage, Cache Storage, service worker cache와 bfcache에 평문이 없음
- 잠금·백그라운드·idle timeout 뒤 DOM, 검색 결과와 clipboard 정리
- Secret 보기·복사는 60초 이내의 최근 재인증만 허용하고 취소·실패·만료·백그라운드 전환 뒤에는 즉시 거부됨
- 중단·중복·역순 회전에서 canonical head와 모든 immutable revision 보존
- 수백 레코드와 다수 연결처의 검색·메모리 성능 한도 충족
- `synthetic-only` 빌드에서 paste, import, deep link, CLI, 확장과 임의 입력 우회가 모두 차단됨

## 10. 수익화 원칙

무료 베타로 신뢰와 복구 가능성을 먼저 검증한다. 공개 Free/Pro 단계에서는 서버가 확인할 수 있는 암호화 레코드 슬롯, 동기화 암호문 용량과 이력 보관기간을 기준으로 한도를 둔다. 실제 API 키 개수나 연결처 내용을 서버가 세거나 읽는다고 주장하지 않는다.

암호화, 복구, 로컬 자격 증명 교체, 읽기, 내보내기와 계정 삭제는 결제벽 뒤에 두지 않는다. cloud sync는 용량·이력 안전 한도를 적용할 수 있지만 결제만을 유일한 해결책으로 요구하지 않고 로컬 보존, 암호화 export와 이력 정리 경로를 제공한다. Pro는 더 많은 암호화 레코드·용량·이력, 일괄 회전 대시보드와 고급 로컬 알림 같은 편의·운영 기능에 과금한다. 다운그레이드로 기존 암호문이나 보호 수단을 삭제하지 않는다.

## 11. 구현 순서

1. 버전형 `CredentialItemV1`·`SecretFieldV1`·`ConnectionV1` 계약과 길이 제한
2. ID·revision 생성과 세션 수명을 소유하는 Rust `vault-local-core`
3. 암호문 전용 로컬 저장소와 재시작 복구
4. 합성 데이터 전용 수동 등록·검색·연결 지도 UI
5. 회전 체크리스트와 충돌 보존
6. Android 생체 승인과 오프라인 사용
7. event wire ADR, 기기 서명과 암호화 동기화
8. 웹 실행 코드·공급망 출시 게이트
9. 별도 위협 모델을 통과한 브라우저 확장·CLI
10. 외부 독립 보안 검토 뒤 실제 Secret 지원
