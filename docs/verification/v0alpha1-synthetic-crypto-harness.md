# `v0alpha1` 합성 암호화 하네스 검증 기록

## 판정

`v0alpha1` 로컬 Rust 하네스는 아래에 적은 **합성 데이터 전용 범위**에서 검증 명령을 모두 통과했습니다. 이 결과는 프로덕션 보안성 인증, 독립 암호 검토 또는 실제 자격 증명 저장 승인을 뜻하지 않습니다.

- 검증 일자: 2026-08-14 (KST, 검증 시작 03:24:25 +09:00)
- 검증 대상 브랜치: `codex/firstvibe-v0alpha1-crypto`
- 검증 대상 코드 커밋: `7fcecc2b281fda3be148521f73d0d82dd3c8d42e`
- Rust: `rustc 1.95.0 (59807616e 2026-04-14)`
- 종합 결과: 아래 결정적 검증 명령 8개 모두 exit code `0`

## 검증된 기능 경계

현재 구현·검증된 기능은 다음뿐입니다.

- 합성 마스터 비밀번호 기반 로컬 Vault Root Key 생성·래핑·잠금 해제
- 합성 레코드의 로컬 seal/open과 버킷 패딩
- canonical CBOR만 허용하는 엄격한 `v0alpha1` 코덱
- 잘못된 비밀번호, 문맥 교체, 암호문 mutation과 비정상 인코딩 거부

다음 항목은 구현되지 않았습니다: 실제 Secret 지원, 복구, 기기 폐기·철회, 영속 저장, 동기화, Web/Android UI, 결제, 스토어 출시, OpenAI plugin.

**실제 아이디, 비밀번호, API 키, Secret, 복구 코드 또는 사용자 금고 데이터를 입력·가져오기·저장하면 안 됩니다.** 다음 게이트는 독립 암호 설계·구현 검토와 별도의 복구/기기 키 ADR입니다.

## 결정적 전체 검증

| 명령 | Exit | 확인 결과 |
| --- | ---: | --- |
| `cargo metadata --locked --format-version 1 --no-deps` | 0 | 잠금 파일을 사용해 단일 workspace package `vault-crypto 0.0.1-alpha.1`을 해석했습니다. |
| `cargo fmt --all --check` | 0 | 포맷 차이가 없습니다. |
| `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings` | 0 | 모든 target·feature가 warning 없이 통과했습니다. |
| `cargo test --workspace --all-features --locked -- --test-threads=1` | 0 | 최상위 test function 48개와 그 안의 trybuild compile-fail case 16개가 통과했고 실패·무시 항목이 없습니다. |
| `cargo run -p vault-crypto --example synthetic_local_alpha --locked` | 0 | 아래의 정확한 합성 예제 stdout 3줄을 출력했습니다. |
| `cargo tree --workspace --locked -d` | 0 | 중복 버전 계열 5개를 보고했습니다. 아래 제한 사항을 참고합니다. |
| `git diff --check` | 0 | 검증 대상 코드 커밋에서 공백 오류가 없습니다. |
| `git status --short` | 0 | Task 7 문서 편집 전 검증 대상 작업 트리는 빈 출력, 즉 clean 상태였습니다. |

합성 예제의 정확한 stdout은 다음과 같습니다.

```text
SYNTHETIC_ALPHA_OK
items=1
tamper_rejected=true
```

`cargo tree -d`는 다음 중복 버전 계열을 확인했습니다: `block-buffer` 0.10/0.12, `cpufeatures` 0.2/0.3, `crypto-common` 0.1/0.2, `getrandom` 0.3/0.4, `syn` 2/3. 명령 성공을 “중복 의존성 없음”으로 해석하지 않으며, 독립 검토에서 프로덕션 dependency surface와 함께 다시 평가해야 합니다.

## 제한적 Secret 패턴 검사

`Get-Command gitleaks` 결과는 `GITLEAKS_UNAVAILABLE`이었습니다. 따라서 `gitleaks dir`과 `gitleaks git` 검사는 실행하지 못했습니다.

대신 `.git/`과 `target/`을 제외하고 다음 범주를 `rg --hidden --pcre2`로 제한 검사했습니다.

- 일반적인 private-key PEM header
- AWS, GitHub, OpenAI/Anthropic 계열, Slack, Google API key의 알려진 접두사·길이 패턴

`rg`의 원시 exit code는 `1`로 일치 항목이 없었습니다. `tests/fixtures/synthetic/v0alpha1-vectors.json`, 그 README, 그리고 새 trybuild `.rs`/`.stderr` fixture 32개도 수동 확인했습니다. 벡터에는 문서화된 합성 문구와 결정적 바이트 배열만 있고 실제 서비스형 토큰은 없습니다.

이 제한적 검사와 수동 확인은 **gitleaks의 대체 동등 검사가 아닙니다**. gitleaks를 사용할 수 있는 검토 환경에서 전체 작업 트리와 Git 이력을 다시 스캔해야 합니다.

## 남은 보안 게이트

- 독립적인 암호 설계·구현 검토 및 벡터 재현
- 별도 복구/기기 키 ADR과 기기 분실·철회 시나리오 설계
- 클라이언트 영속 저장, 플랫폼 키 저장소, 동기화와 공급망 위협 검토
- gitleaks 기반 작업 트리·Git 이력 검사
- 실제 Secret을 허용하기 전 침투 테스트와 복구 훈련

Private GitHub 브랜치는 소스 코드 백업과 검토 표면이며 사용자 금고 데이터의 백업이 아닙니다.

## 2026-08-14 현재 설계 상태 주석

위의 판정·검증 범위·남은 게이트는 `v0alpha1` 하네스 실행 당시 기록으로 그대로 유지합니다. 이후 제품 수준의 복구 정책 ADR 0003은 설계 승인 상태가 됐습니다. 당시 기록의 `별도 복구/기기 키 ADR` 가운데 정확한 recovery wire 계약과 Android 기기 키 정책, 합성 구현, 복구 훈련 및 독립 암호 설계·구현 검토는 여전히 남아 있습니다. 이 주석은 과거 실행 결과를 소급 변경하지 않습니다.

## 최종 리뷰 수정 검증 추가 기록

이 절은 위의 03:24:25 검증 기록을 수정하거나 소급해서 바꾸지 않습니다. 최종 리뷰에서 발견된 키 소유권 및 assurance test 결함을 `98113e7b6df9e1ff09ca39b5fefc8434f35d83ae` 이후에 고친 뒤, 2026-08-14 04:10:04 +09:00부터 별도로 새 검증을 실행한 추가 기록입니다.

### 수정된 보증 경계

- Vault Root Key와 Item DEK의 장기 소유자는 `Box<Zeroizing<[u8; 32]>>` 기반 crate-private owner입니다. 민감 바이트는 이미 zeroizing인 entropy block에서 미리 할당한 heap owner로 직접 복사되며 이후 owner 이동은 key bytes를 다시 복사하지 않고 포인터 소유권만 이동합니다.
- AEAD에는 crate-private closure 안에서만 key slice를 빌려주며 raw key getter를 추가하지 않았습니다. 복호화로 반환되는 Item DEK `Vec`도 모듈 경계를 넘기 전에 `Zeroizing` owner가 됩니다.
- record `key_epoch` 계약은 구현의 기존 `u32` 경계와 일치하도록 `1..=4,294,967,295`로 명시했습니다. 정확히 `u32::MAX`는 수락하고 `u32::MAX + 1`은 `InvalidLength`로 거부합니다.
- well-formed indefinite CBOR byte string은 `NonCanonicalEncoding`으로 거부하며, Item-DEK nonce와 body nonce의 1-byte mutation은 모두 외부에 `AuthenticationFailed`만 반환합니다.

### RED/GREEN 및 전체 검증

- RED: `cargo test -p vault-crypto entropy::tests::root_and_item_keys_keep_heap_storage_across_owner_moves --locked -- --exact --nocapture --test-threads=1`은 수정 전 root-key owner 크기가 32 bytes이고 요구한 pointer size가 8 bytes라서 1개 테스트가 예상대로 실패했습니다.
- GREEN: 같은 테스트는 수정 후 1 passed, 0 failed였습니다. 이어 entropy focused suite 5/5, authenticated malformed-body cleanup 1/1, codec limit suite 22/22, tamper suite 1/1, committed vector public-open test 1/1이 통과했습니다.
- `cargo fmt --all --check`: exit 0.
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`: exit 0.
- `cargo test --workspace --all-features --locked -- --test-threads=1`: exit 0. 최상위 test function 50개와 trybuild compile-fail case 16개가 통과했습니다.
- `cargo run -p vault-crypto --example synthetic_local_alpha --locked`: exit 0이며 stdout은 기존과 동일한 정확한 3줄(`SYNTHETIC_ALPHA_OK`, `items=1`, `tamper_rejected=true`)이었습니다.
- `cargo test -p vault-crypto --test vectors committed_vector_unlocks_and_opens_through_public_api --locked -- --exact --test-threads=1`: 1 passed, 0 failed.
- `tests/fixtures/synthetic/v0alpha1-vectors.json` SHA-256은 수정 전후 모두 `305D55C738AF9C8BF08961891362892A29565ED4AB06C3989E98884C28E4D1BD`로 wire fixture가 변하지 않았습니다.
- 제한적 `rg --hidden --pcre2` secret-pattern 검사는 `.git`, `target`, `.superpowers/sdd`를 제외하고 재실행해 일치 항목이 없었습니다. 첫 호출은 `-----BEGIN`으로 시작하는 pattern이 옵션으로 해석되어 exit 2였고, `--` option terminator를 추가한 교정 명령은 exit 1(no matches), 검증 wrapper 전체는 exit 0이었습니다.
- 이전 plain-array key owner/copy path 패턴 검사는 일치 항목이 없었습니다.
- 보안 수정 커밋은 `c1a5dea60d7177425f01056ade363b5448c868d2` (`fix: harden v0alpha1 key ownership assurances`)입니다.
- commit 전 `git diff --check 98113e7b6df9e1ff09ca39b5fefc8434f35d83ae`: exit 0.
- commit 후 `git diff --check 9c2dee8f9635c68549e36850c6eeb42a85fa7259..c1a5dea60d7177425f01056ade363b5448c868d2`: exit 0.
- commit 후 `git diff --check 98113e7b6df9e1ff09ca39b5fefc8434f35d83ae..c1a5dea60d7177425f01056ade363b5448c868d2`: exit 0.

`gitleaks`는 이번 최종 리뷰 환경에서도 사용할 수 없었습니다. 위의 제한적 pattern 검사는 동등한 대체 검사가 아니며, 실제 Secret 금지와 독립 보안 검토 게이트는 그대로 유지됩니다.
