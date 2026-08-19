# 암호문 SQLite 로컬 저장소 검증 기록

## 결론

이 기록은 합성 데이터 전용 `v0alpha1` 암호문 SQLite 영속 저장 slice를 검증합니다. 사용할 수 있는 비밀번호 관리자나 실제 Secret 출시 승인이 아닙니다.

검증 브랜치는 `codex/firstvibe-sqlite-store`, 승인 범위 기준은 `95d5b7ed0dbdf135d4a9b128a7a04162ce2d2cc2`, 검증 대상 구현 HEAD는 `416f53dfc741f2e8e8b1fc6f6dc4bc42f946ff85`입니다.

## 구현 범위

- opaque envelope BLOB, immutable revision graph, canonical head와 idempotency-first CAS
- stale candidate 암호문 conflict 보존
- bounded no-create read-only preflight, current envelope 인증, 같은 process lock을 유지하는 writable 승격
- close/reopen 뒤 current-head authenticated restore
- wrong-password 무쓰기, future version upgrade-required 보존, current 손상의 store-wide 읽기 전용 보존
- 저장 파일 합성 marker scan, process-crash transaction 원자성, secret-bearing API compile-fail 경계

## 최종 gate

아래 명령은 모두 같은 source root와 사전 승인된 외부 build target에서 실행했습니다. 문서에는 로컬 경로, DB 경로, opaque ID, ciphertext 또는 fixture 값을 기록하지 않습니다.

| 명령 | 종료 코드 | 관찰 결과 |
|---|---:|---|
| `cargo metadata --format-version 1 --no-deps` | 0 | workspace package와 고정 dependency metadata를 읽었습니다. |
| `cargo fmt --all -- --check` | 0 | formatting 차이가 없습니다. |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | 0 | warning 없이 완료했습니다. |
| `cargo test --workspace --all-features -- --test-threads=1` | 1 | 아래 Windows Application Control blocker 때문에 전체 workspace gate는 완료되지 않았습니다. |
| `cargo run -q -p vault-local-store-sqlite --example synthetic_sqlite_roundtrip` | 0 | 아래의 비민감 네 줄을 정확히 출력했습니다. |
| `cargo tree --workspace -e features` | 0 | feature tree를 생성했고 store의 `rusqlite` feature는 `bundled`, `load_extension`입니다. |
| `git diff 95d5b7ed0dbdf135d4a9b128a7a04162ce2d2cc2..HEAD --check` | 0 | 승인 범위 구현 commit에 whitespace error가 없습니다. |

전체 workspace test의 captured run에서는 완료된 harness summary를 합산해 116 passed, 0 failed, 1 ignored까지 확인했습니다. 이어서 `future_and_corruption` test executable을 시작하기 전에 Windows Application Control이 파일 실행을 차단해 `os error 4551`이 발생했습니다. 해당 executable은 **never executed** 상태였고 Cargo는 exit 1로 끝났습니다. 이는 test assertion failure가 아니라 외부 pre-execution blocker이지만, 실행되지 않은 harness와 그 뒤의 harness가 있으므로 full-workspace pass 또는 exit 0을 주장하지 않습니다.

Bounded scan은 다음 exact command로 실행했습니다.

```powershell
rg -n --hidden --glob '!target/**' --glob '!.git/**' --glob '!docs/superpowers/**' -- '(?i)(sk-[a-z0-9]{16,}|api[_-]?key\s*[:=]\s*[A-Za-z0-9_\-]{12,}|secret\s*[:=]\s*[A-Za-z0-9_\-]{12,}|password\s*[:=]\s*[^\s]{8,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' .
```

결과는 예상한 exit 1/no matches가 아니라 exit 0과 64개 candidate line이었습니다. 64개를 전부 수동 분류한 결과는 합성 fixture/data-flow 56개, Rust type parameter 6개, accessor 1개, compile-fail stderr 1개였고 plausible credential은 0개였습니다. 모두 binding regex의 broad `password` branch가 잡은 source-level false positive였지만, binding no-match gate 자체는 통과하지 않았으므로 secret scan pass를 주장하지 않습니다. Candidate 값은 이 문서에 복사하지 않았습니다.

수동 분류를 보조하기 위해 실제 credential assignment 형태만 좁혀 보는 supplementary PCRE2 scan도 실행했습니다. 이 secondary scan은 exit 1, 0 matches였지만 binding scan을 대체하거나 그 결과를 exit 1로 재표현하지 않습니다.

```powershell
rg -n --pcre2 --hidden --glob '!target/**' --glob '!.git/**' --glob '!docs/superpowers/**' -- '(?i)(?:\b(?:api[_-]?key|client[_-]?secret|secret[_-]?key|password|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*(?:r#)?[\x22\x27][^\x22\x27\r\n]{8,}[\x22\x27]|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,})\b|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)' .
```

`gitleaks` 실행 파일은 이 환경에서 unavailable이었습니다. 따라서 `gitleaks git --redact`를 실행하지 않았고 통과했다고 주장하지 않습니다.

Bundled runtime 계약을 확인하는 focused test도 실행했습니다.

```powershell
cargo test -p vault-local-store-sqlite --test lock_and_flags runtime_and_source_lock_extension_and_open_flag_contract -- --exact --test-threads=1
```

결과는 1 passed, 0 failed, exit 0이며 아래 고정 version/runtime 계약을 확인합니다.

## 고정 dependency와 runtime

- `rusqlite`: `0.40.2`
- Cargo feature: default feature 없이 `bundled`, `load_extension`만 사용
- bundled SQLite runtime: `3.53.2`
- `load_extension` feature는 안전한 runtime disable 호출에만 사용하며 store crate는 unsafe code를 금지

## 합성 example의 비민감 출력

```text
synthetic store initialized
encrypted revision committed
store closed and reopened locked
synthetic relationship authenticated
```

## 제한과 미해결 실제 Secret gate

현재 구현은 유효한 과거 DB/WAL 전체 rollback, canonical-head rollback 또는 record/revision 전체 누락을 탐지하지 못합니다. RO→RW logical digest는 같은 process 안의 변경 탐지용이며 persisted/authenticated freshness proof가 아닙니다. Process-crash 원자성 테스트는 임의 hardware power loss를 증명하지 않습니다.

다음 gate는 모두 미해결입니다.

- rollback/누락 anchor
- recovery Key Slot
- hardware-backed device key·biometric flow
- Android 통합
- sync/checkpoint
- 독립 암호 설계·구현 검토
- 침투 테스트
- backup/export 복구 훈련

따라서 실제 비밀번호, API 키, Secret, 복구 키 또는 개인 금고 데이터의 입력·가져오기·저장은 계속 금지됩니다.
