# 공통 자격 증명 작성 경로와 브라우저 실패 안내

## 범위와 상태

- 기준: `0ec551a6a92b739ff98e953d6f4b825325992f61`.
- 작업 브랜치: `codex/firstvibe-credential-commands`.
- `REAL_SECRET_GATE=CLOSED`. 공개 임의 입력/원문 보기/복사/가져오기는 열지 않았다.
- 기존 capacity 브랜치의 원격 CI를 새 push로 취소하지 않기 위해 브랜치를 분리했다.
- 아래는 이 체크포인트의 실제 검사 결과다. 미기록 검사는 통과가 아니다.

## 이번 구현이 제품에서 차지하는 위치

```text
기존 닫힌 API-key 선택 ──→ 공통 내부 typed builder ──→ 기존 seal / archive / CAS
                                ↑
                  Password 합성 Rust 테스트

인증된 기존 레코드 ──→ 이름·메모·태그만 편집 ──→ 새 immutable revision 후보
                         (아직 내부 전용)
```

API 키/비밀번호 종류를 처리하는 코드가 서로 갈라진 데모로 남지 않도록 기존 등록
adapter가 실제로 공통 builder를 사용한다. Password는 식별자(선택)와 비밀번호를
각기 다른 역할·민감도의 SecretValue로 소유하며 field ID는 Rust가 생성한다.
서비스명에 따른 `Example` 특례를 공통 builder에 넣지 않았다.

메타데이터 편집은 이름, 메모, 태그, typed 수정 시각만 받는다. 메모의 Keep/Set/Clear를
구분하고 기존 envelope 인증·parent/successor·canonical encode/seal을 재사용한다.
Secret, credential type, provider/계정 identity, binding, 인증/폐기 상태, 회전 진행은
이 command로 변경할 수 없다. 미완료/ready stage를 일반 편집으로 승격하지 않는다.
완료 event는 기존 revision에 남고 새 metadata revision에 중복 event로 복사되지 않는다.

## 변경 파일 역할

| 파일 | 역할 |
| --- | --- |
| `crates/vault-local-core/src/credential_commands.rs` | private typed draft/builder, metadata allowlist command |
| `crates/vault-local-core/src/credential_commands_tests.rs` | 암호화 왕복·잠금 해제·필드 보존·한계·잘못된 session/변조/future·lifecycle 집중 회귀 |
| `crates/vault-local-core/src/registration.rs` | 기존 API-key adapter가 공통 builder를 실제 사용 |
| `crates/vault-local-core/src/registration_tests.rs` | 이동한 모델 타입의 테스트 import |
| `crates/vault-local-core/src/ids.rs` | 기존 entity ID helper 공유; RNG 의미 유지 |
| `crates/vault-local-core/src/lib.rs` | private mod 선언 및 외부 접근/재수출 차단 compile-fail doctest |
| `apps/web/src/features/local-vault/LocalVaultPanel.tsx` | BRIDGE_FAILURE의 비파괴적 사용자 복구 안내만 추가 |
| `apps/web/src/features/local-vault/LocalVaultPanel.test.tsx` | 오류/상태별 정적 안내 렌더링 검사; 네트워크 성공 증거는 아님 |

public export, wire/schema, Cargo/npm 의존성, 암호 알고리즘, Worker·저장 상태 기계는
변경하지 않았다. 아직 adapter가 없는 Password와 metadata command의 dead_code 허용은
해당 private 선언에만 이유와 함께 붙였고 crate 전체 warning을 끄지 않았다.

## 실행한 검사

| 명령/범위 | 결과 |
| --- | --- |
| `cargo test --offline --locked -p vault-local-core --lib credential_commands -- --test-threads=1` | exit 0; 10 passed, 49.77s |
| `cargo test --offline --locked -p vault-local-core --lib registration -- --test-threads=1` | exit 0; 7 passed, 24.28s |
| `cargo test --offline --locked -p vault-local-core --lib credential_commands::tests::registration_builder_enforces_existing_utf8_and_secret_limits -- --exact --test-threads=1` | exit 0; 1 passed, 마지막 test-only aggregate payload 보강 후 재실행 |
| `cargo test --offline --locked -p vault-local-core --lib -- --test-threads=1` | exit 0; 106 passed, 761.11s |
| UI 안내/기존 panel 집중 테스트 | 구현 agent 보고: 2 files / 12 tests, exit 0 |
| `npm run typecheck` | 구현 agent 보고: exit 0 |
| `cargo clippy --offline --locked -p vault-local-core --all-targets -- -D warnings` | exit 0 |
| `cargo test --offline --locked --workspace --doc` | exit 0; compile-fail 11 passed, 새 private 경계 4개 포함 |
| `cargo fmt --all -- --check` | exit 0 |
| `pwsh -NoProfile -NonInteractive -File scripts/build-wasm.ps1 -Release` | exit 0; 새 default release WASM |
| `pwsh -NoProfile -NonInteractive -File scripts/build-wasm.ps1 -SyntheticDemo -Release` | exit 0; 새 demo release WASM |
| `node scripts/test-wasm.mjs` | exit 0; default 40 checks |
| `node scripts/test-wasm.mjs --demo` | exit 0; demo 1,528 checks |
| `npm test -- --maxWorkers=1` | exit 0; 42 files / 1,360 tests, 82.85s |
| `npm run build` | exit 0; 타입 검사 포함, 48 modules, WASM 약 460.59 kB |
| `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1 -Root <this-worktree>` | 재실행 exit 0; baseline 4, `SECRET_SCAN_PASSED` |
| `git diff --check` | exit 0; 최종 문서 뒤 커밋 전 재확인 |

첫 Secret scan은 `setup_or_execution`, exit 1이었다. 원문/오류 상세를 출력하지 않는
기존 fail-closed 검사가 끝까지 수행되지 않았다는 뜻이며 실제 Secret 발견으로
단정하지 않는다. 동일 명령의 안정된 트리 재실행은 통과했다. 정확한 첫 실패 원인은
확정하지 않았고 scanner·baseline·탐지 패턴을 변경하지 않았다.

직전 capacity 커밋 `0ec551a`의 [원격 CI 35287783960](https://github.com/kjs844-art/secure-vault/actions/runs/35287783960)는
이번 작업 중 `completed/success`, 정확한 head SHA 일치로 확인했다. 이번 신규 코드의
원격 CI 성공 증거로 재사용하지 않는다. 현재 변경은 feature branch 체크포인트로
백업하며 새 exact SHA CI는 push 후 별도로 확인해야 한다.

## 독립 검토와 방어 관점

독립 소스 리뷰에서 Critical/Important 0. 모듈/private 경계, SecretValue 소유권,
caller-selected ID 금지, 연결 부착 후 기존 seal의 전체 검증, metadata allowlist,
67-field 보존 oracle, pending/ready stage 편집 차단을 확인했다.

현재 표시명 검증은 기존 nonempty/max-byte 계약을 유지한다. 공백-only 표시명/provider나
빈 API label의 nonblank 정책은 추후 임의 입력을 열기 전에 정의해야 한다. 이는 이번
닫힌 fixture 경로의 보안 우회 발견은 아니다. Secret/identifier 바이트는 trim하거나
정규화하지 않는다.

실제 브라우저에서는 부분 교체 진행 저장→잠금/새로고침→재열기/진행 복원, 저장본 해시
불변, 360px 가로 폭을 확인했다. 오프라인 Worker 시작 실패도 재현했다. 오류 때 데이터
삭제를 유도하지 않도록 안내만 보완했으며 완전한 오프라인 지원은 구현하지 않았다.
[정확한 브라우저 관찰과 미검증 범위](browser-2026-09-18/report.md)를 따른다.
후속 새 빌드에서도 해당 안내 표시, 암호문 동일성, 온라인 복구 후 재열기를 직접 확인했다.

## 남은 제품 작업과 금지선

1. 현재 v4 canonical 검증은 API-key 회전 checklist/history에 결합되어 있다. 일반
   canonical 무결성 검증과 회전 capability를 분리한 뒤에만 Password를 웹 archive에
   연결한다. `type != ApiKey`이면 검증을 건너뛰는 방식은 금지한다.
2. 임의 사용자 입력·Password 웹 등록·Secret reveal/copy·실제 생체/재인증·계정 관계
   모델은 이번 완료 범위가 아니다. 내부 코드 테스트 통과를 실제 사용자 금고 승인으로
   확대하지 않는다.
3. 전체 워크스페이스/현재 exact SHA CI, 전체 실제 브라우저 회귀, 실제 모바일,
   다운로드·네이티브 파일 선택, 멀티탭 경합과 완전한 오프라인 지원을 구분해 검증한다.
4. 도메인·배포·운영 계정/IAM·가격·최종 디자인·실제 Secret gate·미결 복구 설계와
   signed checkpoint의 별도 승인 조건은 유지한다. main 병합/강제 push는 하지 않는다.

이 체크포인트는 전체 서비스 완성이나 운영 보안 인증이 아니다. 자율 목표는 active다.
