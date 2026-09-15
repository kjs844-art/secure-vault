# 2026-09-14 전체 필드 암호화 보존 후속 검사

## 작업 기준과 목적

- 기준 커밋: `d92346eb3ab0d85e1f1013864d5fba47664afbcb`.
- 작업 브랜치: `codex/firstvibe-record-preservation-followup`.
- 작업 폴더: `C:\Users\USER\Documents\ChatGPT\KeyAtlas\secure-vault-record-followup`.
- 이전 작업의 공개 fixture 3종에는 `rotation_state`가 없었다. 이번에는 기존 test-only 전체 필드 fixture를 암호화 계층까지 연결한다.
- 실제 비밀값 입력, UI, DB 계정 생성, 배포, main 병합은 하지 않는다.

## 검사 흐름

```text
전체 필드 합성 모델 (서로 다른 키 2개 / 시각 / MCP 연결 / 교체 상태)
  → 기존 encode → 기존 seal → 암호문 envelope
  → 생성 세션 drop
  → 잘못된 비밀번호: AuthenticationFailed
  → 올바른 unlock → 기존 open → 67개 필드 비교 → 모델·세션 drop
                                  └─ 총 3회, 매회 암호문 불변 확인
```

추가한 음성 대조는 복원 모델의 교체 상태만 제거했을 때 비교기가 지정한 필드 이름으로 실패하는지 검사한다. 제품 결함 재현이 아니라 비교기 자체의 누락 감지 검사다.

## RED 관점: 무엇을 놓치지 않으려는가

| 위험/검사 빈틈 | 이번 대응 | 남는 경계 |
|---|---|---|
| 선택 필드가 코덱에서는 보존되지만 암호화 왕복에서 누락 | 전체 필드 fixture를 기존 암호화·복호화 경로에 연결 | 일반 입력 API나 교체 실행 기능을 구현한 것은 아님 |
| 교체 상태 삭제를 기존 비교기가 놓침 | 상태를 제거한 음성 대조를 추가 | 교체 상태 전이 전체 검사는 아님 |
| 실패한 인증 뒤 정상 복호화가 불가능 | 실패 뒤 새 세션 3회 생성·복호화 | DB 쓰기 차단이나 프로세스 재시작 검사는 아님 |
| 실패 로그에 비밀값 노출 | 필드 이름과 고정 오류 코드만 assertion에 사용 | 합성 원본은 비교를 위해 메모리에 유지 |
| 테스트 편의 때문에 외부 비밀 입력 경계 확대 | helper 재사용은 cfg(test) 모듈 내부의 crate 가시성에 한정 | 독립 보안 감사는 별도로 필요 |

## BLUE 요약

제품 코드·암호화 형식·공개 API를 변경하지 않고 테스트 2개를 추가했다. 기존 67개 필드 비교기를 재사용한다. 합성 데이터만 사용하며 네트워크 제공자 호출은 없다. GitHub에는 코드와 문서만 올린다.

## 검증 기록

- `cargo test --offline --locked -p vault-local-core --lib -- --test-threads=1`: 24 passed, 0 failed, 종료 코드 0.
- `cargo clippy --offline --locked -p vault-local-core --all-targets --all-features -- -D warnings`: 종료 코드 0.
- `cargo test --offline --locked -p vault-local-core --test persistence_boundary --test secret_traits --test synthetic_record_roundtrip -- --test-threads=1`: 통합 테스트 5개 통과, 실패 0, 종료 코드 0. `secret_traits` 테스트 내부의 컴파일 실패 fixture 10개도 모두 예상대로 거부됐다.
- `cargo fmt --all -- --check`: 종료 코드 0.
- `git diff --check`: 종료 코드 0. README 상대 문서 링크 검사 통과.
- 변경 파일 4개 대상 제한된 자격증명 패턴 검사: 일치 0, 종료 코드 0. 모든 종류의 비밀값 부재를 증명하는 완전한 스캐너는 아니다.
- 자체 diff 검토: 변경은 테스트 2개, test-only helper 가시성, README와 이 기록에 한정된다. 독립 agent 리뷰는 이번에 수행하지 않았다.

## 후속 전체 회귀 검사와 PR (2026-09-14)

- Draft PR: [#2](https://github.com/kjs844-art/secure-vault/pull/2).
- Base: `codex/firstvibe-sqlite-store`, head: `codex/firstvibe-record-preservation-followup`.
- GitHub 사전 확인: OPEN, Draft, MERGEABLE. 자동 CI 결과 목록은 비어 있었다. MERGEABLE은 테스트 통과나 리뷰 승인을 뜻하지 않는다.
- `scripts/verify-local.ps1 -Scope Workspace` 실행 결과는 **실패/미완료(종료 코드 101)**다. 아래 OS 실행 차단 때문에 전체 통과로 보고하지 않는다.

| 검사 | 결과 |
|---|---|
| `cargo fmt --all -- --check` | 종료 코드 0 |
| `cargo clippy --offline --locked --workspace --all-targets --all-features -- -D warnings` | 종료 코드 0 |
| `cargo test --offline --locked --workspace --tests -- --test-threads=1` | 종료 코드 101: SQLite `bounds` 실행 전 Windows 앱 제어 정책 차단, os error 4551 |
| 별도 `cargo test --offline --locked -p vault-local-sqlite-vfs-windows --features feasibility-probe -- --test-threads=1` | 종료 코드 101: lib 테스트 실행 파일도 동일 정책에 의해 실행 전 차단 |
| 별도 `cargo test --offline --locked --workspace --doc` | 종료 코드 0: SQLite compile-fail doctest 2개 통과, 나머지 crate는 0개 |

차단 전 암호화 모듈, 코어 24개와 통합 5개, Windows 플랫폼 2개, 플랫폼 계약 2개가 통과했다. SQLite 단위 검사는 44개 통과/실패 0/ignored 1이었다. ignored 항목은 부모 crash 테스트가 호출하는 자식 진입점이다. 부모의 initial commit 및 stale conflict 프로세스 종료 원자성 테스트는 통과했다.

`bounds.rs`는 실행되지 않았다. 그 뒤의 `commit_cas`, `future_and_corruption`, `lock_and_flags`, `plaintext_scan`, `preflight`, `restart_roundtrip`, `schema_contract`, `secret_traits` 통합 검사도 이번 전체 실행에서는 도달하지 못했다. 예전 통과 기록을 이번 결과로 대체하지 않는다.

보안 정책 해제, 예외 추가, 바이너리 이름 변경, 차단 우회는 하지 않았다. 문서·PR은 이 상태를 명시하며 Draft를 유지한다. 독립 리뷰도 아직 수행되지 않았다.

## 미검증·출시 제한

전체 회귀 통과는 OS 실행 차단 해소 후 재확인이 필요하다. 실제 Windows 핸들 실험, 운영 환경 SQLite/WAL 내구성, 메모리 완전 삭제, 실제 서비스 로그인·결제·배포, 독립 제품 보안 감사는 완료 범위가 아니다. 기존 합성 프로세스 종료 테스트 통과를 운영 환경 전반의 장애 복구 보장으로 확대하지 않는다.

`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`.
