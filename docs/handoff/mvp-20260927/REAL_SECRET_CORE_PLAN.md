# R3A 코어 수명 주기 설계 초안

상태: **DESIGN_ONLY / LOCAL_DRAFT / ISSUE30_BODY_RECEIVED**. 2026-10-03 갱신.
구현·실제 입력·출시 승인이 아니다.
검토 기준: `afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`.
`REAL_SECRET_GATE=CLOSED`. 이 문서는 합성 사례로 계약·검증 계획을 제안한다.

선행 근거: [기존 R3A 인계](REAL_SECRET_AND_BENEFIT_DELIVERY.md),
[보안 아키텍처](../../SECURITY_ARCHITECTURE.md),
[ADR 0004](../../adr/0004-protection-key-slot-wire-v0alpha1.md),
[ADR 0005](../../adr/0005-android-device-key-biometric-invalidation.md).
두 ADR은 현 기준에서 Proposed이며 알고리즘·wire·KDF·기기 복구 구현을 승인하지 않는다.
기존 #25/#27의 상태 계약도 [통합 전 검토](DOMAIN_CONTRACT_REVIEW_2026-10-03.md) 대상으로
분리했다. C03의 CBOR 최상위 요소 수 불일치는 최소 수정안을 기록했고, core/wire 변경은
승인 전 적용하지 않았다. 기록의 official/confirmed를 실제 인증 근거로 사용하지 않는다.
사용자 전달 Issue #30 본문은 R3A 설계·독립 검토를 우선하고 승인 전 실제 Secret core 변경을
금지한다. 지속 작업 요청은 이 조건 안의 합성 보완·설계·검토에 적용한다. 새로운 실제 입력,
wire/KDF/복구 구현 승인은 없다. live API의 이후 변경은 미확인이다.

## 보호 대상과 신뢰 경계

계정 로그인과 Vault Root Key unlock은 서로 다른 권한이다. 현재
`SyntheticVaultSession.reauthentication`의 저장 암호문 재인증을 사용자 재인증으로 세지 않는다.
공개 데모 비밀번호를 실제 생성/unlock에 재사용하지 않는다.

보호 대상은 키, 입력 평문, 복호화된 항목, 보기/복사 권한과 암호문 상태의 최신성이다.
공격/실패 모델에는 오래된 UI·비동기 결과, 다른 사용자/금고/항목의 권한 재사용,
계정 전환·잠금·절전·탭 숨김, 실패한 저장과 불명확한 commit, rollback/누락,
같은 origin의 악성 JavaScript와 플랫폼 clipboard 사본이 포함된다.
Worker/WASM이 같은 origin의 악성 코드로부터 완전 격리를 제공한다고 주장하지 않는다.

## 제안 상태·권한 계약

| 상태/전이 | 필요한 검증과 폐기 규칙 |
| --- | --- |
| 잠김 → unlock 요청 → 열림 | 실제 사용자용 생성/unlock 계약, 인증된 암호문 및 키 소유권. 실패/취소는 잠김 유지 |
| 열림 → 특정 행위 재인증 요청 | 사용자·금고·세션 generation·key epoch·item revision·행위·만료를 캡처 |
| 재인증 성공 → 제한된 보기/복사 | trusted 경계에서 최신 권한 재검사. UI boolean이나 계정 로그인만으로 허용하지 않음 |
| 잠금/숨김/만료/철회/전환 | generation 무효화, 소유 요청 취소, 늦은 결과 폐기, 표시 state/DOM 참조 정리 |
| 저장 → 재조회/재시작 복구 | 인증된 정확한 상태의 원자 commit·CAS·재조회 확인. timeout을 rollback 증명으로 쓰지 않음 |

행위 권한은 최소한 `(principal, vault, sessionGeneration, keyEpoch, itemRevision,
action, issuedAt, expiresAt, requestIdentity)`에 결합하는 **설계 제안**이다.
직렬화 형식·숫자 TTL·서명/발급 주체·재사용 정책은 미결이며 기존 protocol에 추가하지 않는다.
정확한 경과 시간과 시계 이상·절전 후 검사, 요청의 최신 generation 확인을 함께 설계한다.
표시/clipboard 작업 직전 및 비동기 반환 후에도 권한을 재검사한다.

평문은 명시적 행위에서 필요한 한 항목만 허용된 sink에 전달하는 방향으로 검토한다.
목록·검색 projection, 로그·URL·오류·analytics·AI/MCP·서버에는 평문을 넘기지 않는다.
범용 raw-key/secret getter를 노출하지 않는다. JS 문자열·DOM·개발자 도구·화면 캡처까지
안전하게 지워졌다고 보장하지 않으며, Rust zeroization의 적용 범위를 구분한다.

clipboard에는 OS 기록·동기화·다른 앱이 사본을 남길 수 있다. 자동 비우기는 시도와 성공을
분리해야 하며 이미 생긴 사본의 회수나 안전한 자동 삭제를 보장하지 않는다.
거절·취소·지원 불가·잠금과 늦은 쓰기의 결과를 사용자가 구분할 수 있게 설계한다.

## 후보 파일과 구현 전 승인 목록

아래는 읽기 검토 대상이다. 수정 허용 manifest가 아니다.

| 경계 | 후보 경로 | 구현 전에 결정할 것 |
| --- | --- | --- |
| Rust 소유권·입력·저장 | `crates/vault-local-core/src/secret.rs`, `registration.rs`, `persistence.rs`; `crates/vault-client-wasm/**` | 실제 입력 계약, 비밀 소유 객체, 검증·원자 저장·반환/실패 표면 |
| bridge/Worker/세션 | `apps/web/src/bridge/**`, `apps/web/src/features/local-vault/SyntheticVaultSession.ts`, `SyntheticVaultWorkerClient.ts`, `syntheticVault.worker.ts` | capability 검증 위치, generation/취소, 평문 전송 최소화·격리 모델 |
| 표시 행위·앱 셸 | 기존 합성 UI와 M01A 소유 셸 | 현재 합성 표시와 실제 unlock의 구분, 승인된 sink·수명·한국어 안내 |
| wire·복구·기기 | `contracts/**`, 관련 crypto/store crate와 ADR 0004/0005 | ADR Accepted, 독립 암호 검토, wire/vector/registry·migration·recovery 계획 |

구현 전에는 정확한 base SHA, 변경 파일 목록과 담당, 승인된 dependency/version,
독립 리뷰 대상, 복구·rollback/누락 anchor·키 폐기·sync·backup 검증 계획을 확정한다.
Root Key·복구 secret·실제 키 입력, 기존 wire/KDF 또는 lockfile을 이 설계 작업에서 바꾸지 않는다.

## 합성 검증 계획과 출시 게이트

필수 부정 경로: 잘못된/취소된 재인증, 동시 행위, 다른 항목·epoch·세션 재사용,
만료 경계 전후, 잠금/숨김 중 늦은 성공·실패, 시계 이상, 실패한 저장·불명확한 commit,
CAS 충돌, 재시작 복구, rollback·누락·키 폐기와 복구 수단 상실이다.
mock의 표시/clipboard 검사는 실제 브라우저·OS의 권한·포커스·타이머 검사와 분리한다.

R4A가 이 설계와 이후 고정 구현 SHA를 독립 검토해야 한다. 주 담당의 자기 검토는 대체 증거가 아니다.
설계 검토 → 합성 prototype 승인 → 정확한 구현 검증 → 독립 암호/플랫폼 검토 →
복구 훈련 및 실환경 승인 → 실제 Secret 출시 판단은 각각 별도 단계다.
현재는 첫 단계의 초안 작성이며 후속 단계는 **NOT_RUN**이다.
