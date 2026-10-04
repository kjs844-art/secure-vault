# KA-D01 / KA-C03 통합 전 계약 검토

2026-10-03 / READ_ONLY_REVIEW / DESIGN_ONLY.
현재 checkout HEAD `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`의 core/wire를 변경하지 않았다.
다음 원격 제출물의 source만 읽고, 별도 임시 archive에서 기존 합성 unit 검사를 실행한다.
새 실제 Secret·auth·복구·core 구현 승인이 아니다. `REAL_SECRET_GATE=CLOSED`.

| 제출물 | 검토한 정확한 SHA | 현재 판단 |
| --- | --- | --- |
| #25 KA-D01 | `a72a6817ef1970c271850af18415b6fb9f5550c7` | consent/subscription 상태 계약. 실제 철회·구독/결제 adapter 없음 |
| #27 KA-C03 | `9dc9af3d980ba574ab0afb8715b5bd0c2239d036` | #25를 포함하는 후속. 로그인 출처 기록 계약, 실제 OAuth/OIDC/Passkey·세션 없음 |

`git merge-base --is-ancestor a72a6817ef1970c271850af18415b6fb9f5550c7
9dc9af3d980ba574ab0afb8715b5bd0c2239d036`는 exit 0이다. 두 제출물을 각각 중복 이식하지 않는다.
이번 앱 합성 통합은 #24/#26/C06의 표시 영역이며 #25/#27 core 계약 통합과 별개다.

## C03: CBOR 최상위 요소 수 불일치

`crates/vault-local-core/src/login_method.rs`의 위 #27 source에서:

- 16행 `REGISTRY_FIELD_COUNT = 3`.
- 161~173행 `encode_registry_into`는 array 길이를 3으로 쓰고 실제로는
  `schema_version`, `accounts` 두 요소만 기록한다.
- 267~282행 decoder도 header 3을 요구하지만 실제 읽기는 version과 accounts 두 요소다.
- `contracts/local-v1/login-method-registry-v1.cddl`은 version과 accounts 두 요소를 정의한다.
  Markdown은 '정확히 3 필드'라고 적어 이와도 맞지 않는다.

이는 일반 CBOR 표현과 계약의 **정적 일관성 결함**이다. 같은 encoder/decoder의 내부
roundtrip 성공만으로 외부 CBOR parser나 CDDL 준수를 증명할 수 없다. 악의적 입력이나
실제 저장소에 대한 재현은 하지 않았으며, 현재 운영/보안 영향은 미평가다.

최소 수정안은 상수를 2로 맞추고 Markdown도 2로 정정한 뒤, 자체 decoder 이외의 기존
표준 CBOR 도구로 최상위 구조·문서 전체 소비·vector를 검증하는 것이다. 새 dependency는
추가하지 않는다. 기존 산출물이 저장/배포됐는지와 호환성·version/migration 결정은 먼저
확인해야 한다. 승인된 core/wire manifest와 리뷰 전에는 적용하지 않는다.

## D01: 문서와 검증 의미를 먼저 결정할 항목

1. Markdown의 `policy_version`은 '문서 내 고유'라고 적지만
   `consent.rs` 149~178행은 비어 있지 않음/32 bytes 및 상태 조건만 검사한다.
   같은 policy를 여러 grant가 참조할 수 있는지부터 결정해 문서/검사 중 맞는 쪽을 정한다.
   consent ID의 고유성 검사는 별도 존재하며 이를 policy 고유성으로 세지 않는다.
2. 현재 withdrawn은 날짜를 요구하고 `EvidenceSourceV1::User`를 거부한다.
   외부 철회 확인의 기록 계약과 사용자가 KeyAtlas의 로컬 수집/분석 동의를 즉시 철회하는
   authority 동작은 서로 다르다. 후자를 provider 확인 전까지 지연시키는 근거로 사용하지 않는다.
3. subscription active/paid와 consent의 상태 기록은 실제 구독·결제·외부 마케팅 동의 증명이
   아니다. 실제 취소 adapter·provider acknowledgement·불명확한 결과·재조회는 별도 범위다.

이 항목은 현재 source 의미/문서의 차이와 통합 결정을 정리한 것이다. 모든 항목을 보안
취약점으로 판정하거나 기존 실제 연결의 결함이라고 가정하지 않는다.

## 인증·표시·수명 경계

| 기존 상태 | 후속 통합에서 유지할 구분 |
| --- | --- |
| C03 `official_integration` 열거값 | 합성 기록에서 유효해도 실제 로그인 성공·계정 소유 인증 아님. trusted 인증/session을 발급하는 근거로 사용 금지 |
| C03 수동 account 식별자/notes | 실제 자료 사용 전 목적/최소 입력·projection·보존/삭제·금고 wire 승인 필요. 검색·로그·URL·AI로 raw 자료 확대 금지 |
| D01 grant/state | R5A purpose/revision/recipient/policy와 현재 trusted authority를 대체하지 않음 |
| C04 manual confirmed / C06 가입 문구 | 가입/소유권/현재 잔액 증거가 아님. C03 official 출처나 D01 provider 확인으로 자동 승격 금지 |
| 미래 schema의 UpgradeRequired | 실제 지속 저장·보존·migration·rollback 규칙과 연결해 검증. UI DTO만으로 보존 완료 주장 금지 |

## 검사와 후속 순서

기존 검사는 `/tmp/keyatlas-cloud-inbox-20261003/pr27-readonly-source`의 **변경하지 않은**
#27 archive(Cargo/lock/toolchain/crates/contracts)에서 fixed Rust·offline/locked로 실행한다.
`cargo test --offline --locked -p vault-local-core --lib consent_tests`는 6 PASS / exit 0,
`cargo test --offline --locked -p vault-local-core --lib login_method_tests`는 8 PASS / exit 0이다.
정확한 기록은 `pr27-readonly-checks.json`과 최근 통합 검증에 있다.
이는 current HEAD core 통합, 실제 auth, 외부 CBOR 호환성 또는 독립 보안 PASS가 아니다.

1. 계약 요소 수·policy 의미·현재 저장 산출물과 migration 필요성을 확인한다.
2. 사용자 승인된 exact SHA/파일 manifest로 core/wire의 제한된 보완 범위를 확정한다.
3. 기존 제출물의 집중 검사와 표준 구조/vector·future/schema·호환성 검사를 함께 수행한다.
4. 공용 bridge/store/UI가 필요한 projection과 합성 연결 범위를 따로 승인·검증한다.
5. 독립 리뷰 및 실제 R3A/R5A gate를 통과하기 전 실제 인증/Secret/외부 동작으로 보고하지 않는다.

관련 설계: [R3A](REAL_SECRET_CORE_PLAN.md),
[R5A 목적/승인](R5A_PURPOSE_AND_ACCEPTANCE_2026-10-03.md),
[완료/잔여/추정](SERVICE_READINESS_2026-10-03.md).
