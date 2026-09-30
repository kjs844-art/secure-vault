# KA-C03 로그인 출처 기록 계약 검증

`tested_commit`: `a72a681` 기반 작업 브랜치 `vibe/ka-c03-login-method-record-e994d4`

이 기록은 `KA-C03`의 로컬 합성 검증 결과다. 실제 Google·Kakao·Naver·Passkey
인증 연동은 승인되지 않았다.

## 범위

- `contracts/local-v1/login-method-registry-v1.cddl` — Login Method Registry v1 CDDL 계약
- `contracts/local-v1/login-method-registry-v1.md` — 상태·검증 규칙 문서
- `crates/vault-local-core/src/login_method.rs` — 도메인 모델, canonical CBOR 코덱, 전역 검증
- `crates/vault-local-core/src/login_method_synthetic.rs` — 합성 fixture 및 미래 버전 prefix
- `crates/vault-local-core/src/login_method_tests.rs` — 검증 테스트

## 검증 결과

| Command | Exit | Result |
| --- | ---: | --- |
| `cargo test -p vault-local-core --lib` | 0 | 38 passed, 0 failed (기존 30 + 신규 8) |
| `cargo test -p vault-local-core --lib login_method` | 0 | 신규 login-method 테스트 8개 전부 통과 |
| `cargo fmt --all -- --check` | 0 | 포맷팅 변경 없음 |
| `cargo clippy -p vault-local-core --all-targets --all-features -- -D warnings` | 0 | 경고 0 |

## 검증 항목

- 합성 계정·로그인 방식 레지스트리의 canonical CBOR roundtrip
- Google·Kakao·Naver·Email·Passkey·Manual 6종 방식과 user_recorded·official_integration·unknown
  3종 출처(provenance)의 표현 가능성 — 수동 기록과 공식 연동 출처 구분이 계약상 강제됨
- 로그인 방식이 0개인 계정 거부 (1..=16개 강제)
- 중복 `account_id`, 계정 내 중복 `method_id` 거부
- `last_observed_at`이 `recorded_at`보다 이전인 경우 거부
- 미래 스키마 버전(`v2`)의 보존·보고 (`UpgradeRequired`)
- 잘린 payload, 후행 바이트, 빈 배열 등 비정형 인코딩 거부

## 합성 데이터 전용 경계

모든 테스트 데이터는 합성 fixture이며 실제 서비스·계정 식별자·인증 프로토콜 흔적을
포함하지 않는다. 실제 OAuth/OIDC/Passkey 인증 수행·세션 관리는 이 작업 범위가 아니다.

## 환경

- Verified at: `2026-09-30T07:05:00Z` (UTC)
- Linux sandbox
- Rust: `rustc 1.95.0 (59807616e 2026-04-14)`, Cargo `1.95.0`
