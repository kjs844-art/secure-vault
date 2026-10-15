# KA-D01 ConsentGrant·Subscription contract 검증

`tested_commit`: `ceca9f43c4f92b3b0e4081d84be8612b10f03582` (작업 브랜치 `vibe/ka-d01-consent-contract-e994d4`)

이 기록은 `KA-D01`의 로컬 합성 검증 결과다. 실제 외부 구독·결제·동의 철회 연동은
승인되지 않았다.

## 범위

- `contracts/local-v1/consent-center-v1.cddl` — Consent Center v1 CDDL 계약
- `contracts/local-v1/consent-center-v1.md` — 상태·검증 규칙 문서
- `crates/vault-local-core/src/consent.rs` — 도메인 모델, canonical CBOR 코덱, 전역 검증
- `crates/vault-local-core/src/consent_synthetic.rs` — 합성 fixture 및 미래 버전 prefix
- `crates/vault-local-core/src/consent_tests.rs` — 검증 테스트

## 검증 결과

| Command | Exit | Result |
| --- | ---: | --- |
| `cargo test -p vault-local-core --lib` | 0 | 30 passed, 0 failed (기존 24 + 신규 6) |
| `cargo test -p vault-local-core --lib consent` | 0 | 신규 consent 테스트 6개 전부 통과 |
| `cargo fmt --all -- --check` | 0 | 포맷팅 변경 없음 |
| `cargo clippy -p vault-local-core --all-targets --all-features -- -D warnings` | 0 | 경고 0 |

## 검증 항목

- 합성 ConsentGrant·Subscription 문서의 canonical CBOR roundtrip (부호화→복호화→재부호화 일치)
- `state=withdrawn`인 ConsentGrant의 `withdrawn_at` 필수 및 `evidence.source != user` 강제
- `state=granted`인 ConsentGrant의 `withdrawn_at` 금지
- 중복 `consent_id`, `subscription_id` 거부
- Subscription의 dangling·중복 `consent_refs` 거부
- 미래 스키마 버전(`v2`)의 보존·보고 (`UpgradeRequired`)
- 잘린 payload, 후행 바이트, 빈 배열 등 비정형 인코딩 거부
- 빈 문서(ConsentGrant 0개, Subscription 0개)의 유효성

## 합성 데이터 전용 경계

모든 테스트 데이터는 합성 fixture이며 실제 서비스·결제 수단·동의 문구를 포함하지 않는다.
실제 Secret 입력·외부 구독 연동·동의 철회 어댑터는 이 작업 범위가 아니다.

## 환경

- Verified at: `2026-09-30T06:45:23Z` (UTC)
- Linux sandbox
- Rust: `rustc 1.95.0 (59807616e 2026-04-14)`, Cargo `1.95.0`
