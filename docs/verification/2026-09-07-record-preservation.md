# 2026-09-07 합성 금고 데이터 필드 보존 검사

## 범위와 완료 기준

사용자가 로그인·결제·화면 작업을 미룬 동안, 외부 계정이나 실제 키 없이 가능한 내부 회귀 검사를 보강했다. 목적은 저장 전후의 **내용이 정확히 같은지** 확인하는 것이다. 제품의 데이터 손실이나 침해가 발견됐다는 보고가 아니다.

- 기존 암호화·코덱·잠금 해제 흐름을 그대로 사용한다.
- 모델 6종의 67개 필드를 값 단위로 비교한다. 선택값 유무, 배열 길이와 순서, 연결 관계도 포함한다.
- 비교기가 잘못된 데이터를 실제로 구별하는지 합성 데이터 음성 대조 3개로 확인한다.
- 생성 세션을 버린 뒤 새로 잠금 해제해 공개 합성 fixture 3종을 비교한다.
- 전체 워크스페이스 회귀 검사, 형식 검사, 관련 Clippy 및 문서 검사를 새로 실행한다.

## 이번 변경 파일

| 파일 | 역할 |
|---|---|
| [codec_preservation_tests.rs](../../crates/vault-local-core/src/codec_preservation_tests.rs) | 전체 필드 비교기, full/minimal 코덱 왕복, 비교 민감도 검사 3개 |
| [codec.rs](../../crates/vault-local-core/src/codec.rs) | 새 모듈을 `cfg(test)`로만 연결 |
| [record_tests.rs](../../crates/vault-local-core/src/record_tests.rs) | 암호화 → 생성 세션 drop → 새 세션 unlock → 복호화 후 필드 비교 |
| [crate README](../../crates/vault-local-core/README.md) | 회귀 검사 범위와 메모리/디스크 구분 안내 |
| 이 문서 | 작업 이유, 실행 증거, RED/BLUE 관점과 미검증 경계 |

작업 경로: `C:\Users\USER\Desktop\PersonalProJect\KeyAtlas\worktrees\secure-vault-sqlite-store-design`

기존 미커밋 변경은 보존한다. 제품 암호화 알고리즘·저장 형식·공개 입력 API는 변경하지 않으며, 커밋·푸시·배포·실제 Secret 활성화도 하지 않는다.

## 어떤 흐름을 검사하나

```text
합성 모델 ── encode ──> 바이트 ── decode ──> 복원 모델
    └───────────────── 67개 필드 비교 ────────────┘

공개 합성 fixture 3종 ── seal ──> 메모리에 보관한 암호문
                                    │
생성 세션 drop → password envelope로 새 unlock
                                    │
                         open → 원본과 필드 비교
```

비교기는 `CredentialItemV1` 30개, `SecretFieldV1` 7개, `ConnectionV1` 14개, `McpIntegrationV1` 8개, `CredentialFieldBindingV1` 2개, `RotationStateV1` 6개를 처리한다. 모델 필드가 추가되면 검토 없이 통과하지 않도록 `..` 없는 패턴으로 필드를 열거한다. 중첩 타입·선택값·배열은 별도 비교기로 연결한다.

## RED 중심: 기존 검사가 놓칠 수 있던 것

기존 full roundtrip 검사는 일부 선택값의 존재와 배열 개수를 확인했지만 모든 내용을 직접 비교하지 않았다. 또한 두 합성 secret과 여러 시각이 같은 값이면, 서로 바뀌어도 테스트가 그 차이를 잡기 어렵다. 이것은 **검사 범위의 빈틈**이며 실제 구현의 잘못된 동작을 재현한 것은 아니다.

| 실패 가능성 | 이번 확인 |
|---|---|
| 키 2개의 내용이 뒤바뀜 | 서로 다른 합성 secret 사용. 성공적으로 decode한 뒤 값만 교환하면 비교기가 지정한 필드에서 실패하는지 확인 |
| 생성·발급·검증·회전 시각이 뒤섞임 | 서로 다른 UTC 시각 9개 사용. 생성/발급 시각 교환 음성 대조 추가 |
| MCP 환경변수가 다른 키 필드에 연결됨 | binding의 이름과 field ID를 모두 비교. target ID 변경 음성 대조 추가 |
| 선택값 누락이나 빈 배열 처리 오류 | 모든 선택값이 있는 사례와 최소 사례를 각각 왕복 비교 |
| 한국어·줄바꿈·이모지 내용 손실 | 명시적인 합성 표시가 있는 문자열을 바이트/값 그대로 비교 |
| 검사가 실패하면서 키 내용을 로그에 출력 | 비밀값에 `assert_eq!`/Debug 출력을 쓰지 않고, 차이가 난 타입·필드 이름만 출력 |
| 메모리 검사를 디스크 복구 검증으로 오인 | 신규 record 검사는 메모리 암호문과 새 세션을 사용한다고 명시 |

음성 대조는 잘못된 비교 결과를 받아들이지 않는지 확인하는 `should_panic(expected = ...)` 테스트다. **제품 버그로 실패했다가 고쳤다는 RED→GREEN 결과로 계산하지 않는다.** 외부 시스템, 실제 비밀번호, 실제 API 키를 사용하지 않는다.

## 실행 기록

- 연결 전 기존 codec 테스트: 4개 통과, 종료 코드 0 (`CODEC_BASELINE_EXIT=0`).
- 새 검사를 연결한 core lib 테스트: 22개 통과, 실패 0, 종료 코드 0 (`CORE_PRESERVATION_LIB_EXIT=0`). 신규 검사는 총 6개다.
- 첫 형식 검사: 새 테스트 파일 2개의 줄바꿈/정렬 차이로 종료 코드 1. 해당 2개 파일만 rustfmt로 정리했다.
- 정리 후 `cargo fmt --all -- --check`: 종료 코드 0 (`PRESERVATION_FORMAT_CHECK_EXIT=0`).
- 관련 Clippy: `cargo clippy --offline --locked -p vault-local-core --all-targets --all-features -- -D warnings`, 종료 코드 0 (`PRESERVATION_CORE_CLIPPY_EXIT=0`). 워크스페이스 전체 Clippy 결과로 확대하지 않는다.
- 별도 작성자의 읽기 전용 정적 리뷰: 67개 필드, 비교 민감도, 값 출력 여부, test-only 경계, 기존 암호화/잠금 해제 호출 경로를 확인했다. 수정이 필요한 결함은 보고되지 않았다. 작성 agent의 자체 재검토와 구분하며, 독립 제품 보안 감사를 뜻하지 않는다.
- 형식 정리 이후 기본 기능 워크스페이스 회귀 검사는 진행 중이며 결과 확인 전에는 완료로 간주하지 않는다.

## BLUE 요약 및 남은 경계

- 제품 동작을 바꾸지 않고 기존 흐름의 값 보존을 더 엄격히 검사한다.
- 새 helper와 연결은 `cfg(test)`에 한정된다. 외부에 원문 접근 API나 새 Debug/Serialize 구현을 노출하지 않는다.
- 이 테스트 동안 비교용 원본과 합성 마스터 비밀번호는 메모리에 남아 있다. 세션 drop을 모든 평문 삭제·OS 메모리 보호 증명으로 해석하면 안 된다.
- 신규 record 검사는 SQLite, WAL, 파일 시스템, 실제 프로세스 종료·재시작을 사용하지 않는다. 전체 회귀 검사에 기존 저장소 테스트가 포함돼도 그 경계와 구분한다.
- 공개 fixture 3종의 `rotation_state`는 모두 `None`이다. 모든 선택값을 채운 67개 필드의 코덱 왕복 검사와, 공개 fixture 3종의 암호화·재잠금 해제 검사를 구분한다. 암호화된 회전 워크플로가 구현·검증됐다는 의미가 아니다.
- 이번 워크스페이스 실행은 기본 기능의 `--tests` 범위다. doctest, feature-gated 실제 Windows 핸들 실험, 명시적으로 ignored된 검사를 실행했다고 주장하지 않는다.
- 독립 제품 보안 감사, 외부 침투 테스트, Windows Phase 0A 판정, 복구·신뢰 기기·기기 폐기, 실제 Secret 사용 승인은 이번 작업 범위 밖이다.
- UI·로그인·결제·실서비스 배포 완료를 뜻하지 않는다.
- `PHASE_0A_VERDICT=UNCHANGED`, `REAL_SECRET_GATE=CLOSED`를 유지한다.

## 다시 실행

저장소 루트에서, 설치된 Rust 도구와 캐시를 사용한다.

```text
cargo test --offline --locked -p vault-local-core --lib -- --test-threads=1
cargo test --offline --locked --workspace --tests -- --test-threads=1
cargo clippy --offline --locked -p vault-local-core --all-targets --all-features -- -D warnings
cargo fmt --all -- --check
git diff --check
```

앞선 테스트 실행 도구 변경은 [대역 격리 기록](2026-09-07-fixture-isolation.md)과 구분해서 읽는다.
