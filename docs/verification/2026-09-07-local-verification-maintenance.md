# 2026-09-07 로컬 검증 유지보수 기록

## 작업 목표와 경계

- 사용자 요청: 이동한 KeyAtlas 폴더에서 약 2시간 작업한 뒤, 안전한 경우 작업 종료 10분 후 Windows 종료.
- 작업 시간: 2026-09-07 01:55~03:55 KST 예정. 종료 상태는 아래 최종 기록에서 구분한다.
- 작업명: KeyAtlas (working title). 제품명 확정, 실제 자격 증명, 공개 배포, 결제 활성화는 이번 범위가 아니다.
- 기본 브랜치나 다른 AI의 변경을 건드리지 않고 검증 실행 경로와 기록을 보강한다. 커밋·푸시·PR 변경·main 병합은 하지 않는다.

## 실제 경로와 기준점

```text
C:\Users\USER\Desktop\PersonalProJect\KeyAtlas\
├─ secure-vault\                          main 체크아웃 (9c2dee8)
├─ worktrees\
│  └─ secure-vault-sqlite-store-design\    이번 작업 폴더
└─ 자료\KeyAtlas_보안_설계_패키지_2026-08-29\
```

작업 브랜치는 `codex/firstvibe-sqlite-store`, 시작 HEAD는 `f85e547`이다. 2026-09-07 03:14 KST에 읽기 전용 `git ls-remote`가 exit 0으로 실제 origin 기능 브랜치 SHA `f85e547b270b3400c924ea8afe9e1f36d846b661`을 반환했고 로컬 HEAD와 일치했다. 단, 오늘의 미커밋 소스·문서 변경은 이 SHA에 포함되지 않으며 GitHub 백업 완료와 다르다. PR 상태나 다른 원격 브랜치는 이번 확인 범위가 아니다.

## 이번에 변경한 코드와 이유

| 파일 | 역할과 변경 |
|---|---|
| `scripts/verify-local.ps1` | 이동 후에도 스크립트 기준으로 workspace를 찾아 일반 검사를 실행하는 단일 진입점. 검사 실패를 숨기지 않고 즉시 실패 코드를 전달한다. |
| `tests/verification/verify-local.Tests.ps1` | 별도 PowerShell 프로세스로 실제 스크립트를 호출해 옵션, 작업 경로, 단계별 실패와 최종 상태를 검사한다. |
| `tests/verification/fixtures/cargo.cmd` | 외부 네트워크나 실제 Rust 오류 주입 없이 명령 호출 기록과 합성 종료 코드 23을 제공하는 테스트 전용 대역. 실제 Cargo가 아니다. |
| `README.md` | 초보자용 실행 명령, 검사 범위, 오프라인 의존성 및 보안 경계 안내. |
| `docs/PRODUCT_BUILD_AND_DEPLOY_GUIDE.md` | 오래된 실행 차단 기록과 이번 일반 테스트 통과를 구분하고 현재 작업 경로를 갱신한다. |
| 이 문서 | 실제 검사 결과, 독립 검토 범위, 미검증 항목 및 마무리 기록. |

작업 시작 전부터 수정돼 있던 다음 두 파일은 그대로 보존했다. 기존 `#![cfg(feature = "feasibility-probe")]`가 옵션 전용 테스트를 기본 빌드에서 분리하며, 이번 세션에서 새로 만든 수정으로 계산하지 않는다.

- `crates/vault-local-sqlite-vfs-windows/tests/actual_handle_feasibility.rs`
- `crates/vault-local-sqlite-vfs-windows/tests/support/mod.rs`

Rust 제품 기능·암호화 설계·저장 형식·의존성 잠금 파일은 이번에 변경하지 않았다.

## 실제 검증 결과

다음은 테스트 실행을 관찰한 결과다. 정적 검토나 가짜 Cargo 테스트와 분리해서 기록한다.

| 검사 | 실제 결과 |
|---|---|
| `cargo test --offline --locked -p vault-local-sqlite-vfs-windows --tests -- --test-threads=1` | exit 0. 기본 구성 2 passed, feature 전용 테스트 대상 0개 실행. |
| `cargo test --offline --locked --workspace --tests -- --test-threads=1` | exit 0. 총 168 passed, 1 ignored. ignored는 부모 테스트가 호출하는 합성 crash child 진입점이다. trybuild 개별 컴파일 사례는 상위 Rust 테스트 안에서 실행된다. |
| `cargo test --offline --locked -p vault-local-sqlite-vfs-windows --features feasibility-probe -- --test-threads=1` | exit 0. 일반 검사 6 passed, 명시적 Phase 0A gate 1 ignored. |
| `cargo fmt --all -- --check` | exit 0. |
| `cargo clippy --offline --locked --workspace --all-targets --all-features -- -D warnings` | exit 0. |
| `cargo test --offline --locked --workspace --doc` | exit 0. |
| `git diff --check` | 중간 및 최종 문서 변경 후 검사 exit 0. 추적된 변경의 공백 오류 검사이며 전체 코드 보안 검사를 뜻하지 않는다. |
| 실제 `verify-local.ps1` 기본 Focused 실행 | exit 0. 단계별 실제 Cargo 검사와 CLOSED/UNCHANGED 결과 표시 확인. |
| 스크립트 자체 회귀 검사 | Windows PowerShell 5.1과 PowerShell 7.6.5에서 각각 11개 통과, exit 0. 이는 명령 구성과 실패 전파 검증이며 Rust 암호화 안전성 증명이 아니다. |
| 변경 문서 점검 | README·제품 가이드·검증 기록·바탕화면 문서의 로컬 링크 19개 중 깨진 링크 0개. UTF-8 읽기 성공. 기록한 코드 SHA-256 5개도 실제 파일과 모두 일치한다. |
| 제한된 비밀 패턴 검사 | 이번 추가 코드 및 저장소 변경 문서에서 대표적인 개인키/토큰 형식과 일치하는 파일 0개(rg exit 1 = 검색 결과 없음). 모든 비밀 유형·Git 역사·실데이터를 검사한 결과는 아니다. |

새 Workspace 진입점도 전체 재실행했다. 첫 백그라운드 실행은 5개 단계 exit 0과 성공 요약을 기록했지만 호출자의 최종 Process.ExitCode가 비어 있어 이를 0으로 해석하지 않았다. 동일 코드를 PowerShell 7에서 직접 다시 실행했고 2026-09-07 03:31 KST까지 최종 `KEYATLAS_WORKSPACE_RUNNER_FINAL_EXIT=0`을 확인했다. 기본 168 passed/1 ignored, feature 일반 6 passed/1 ignored, 문서 예제 2 passed였고 format·Clippy도 exit 0이었다. 이후 제품 코드나 스크립트는 변경하지 않았다.

호스트 관찰값: Windows `10.0.26200`, Rust `1.95.0`, `x86_64-pc-windows-msvc`. 이번 작업에서 Application Control/Smart App Control, 인증서 신뢰, 레지스트리, OS 보안 설정을 변경하지 않았다. 과거 4551 차단 원인의 해소 경위는 이번에 조사하지 않았으므로 영구 해결로 판단하지 않는다.

빌드 출력은 무시되는 `target/` 아래 보관한다. 예: `keyatlas-verification-20260907-ordinary.log`, `keyatlas-final-workspace.stdout.log`, `keyatlas-final-workspace.stderr.log`. 이 로그는 Git에 포함되지 않으며 로컬 보조 증거다.

## 테스트 먼저 작성한 과정

검사에 사용한 변경 코드의 SHA-256(로컬 파일 바이트 기준)은 다음과 같다. 이 식별값은 실행 대상 구분용이며 보안 인증이나 서명이 아니다. 줄바꿈 변환 시 값이 달라질 수 있다.

```text
FE5A7A1DF0C4111AE49F774C76F223F05F646284196D5CF0560A14EE7E2F22C8  scripts/verify-local.ps1
502239BD9789A29FA47E1879A267DD70621590911A19F04A65653B355545E39A  tests/verification/verify-local.Tests.ps1
23641B49A8C7D45AAB89D2140E3771DF34A8B8B7DF3D7E18EB813A78E7E0FBBA  tests/verification/fixtures/cargo.cmd
92D0C67B6E605B87F31CE80F10D455096528131A3754765360F38279D6E54D1C  crates/vault-local-sqlite-vfs-windows/tests/actual_handle_feasibility.rs
B84AEF0AE30F38291494F35F8891EFC1401F6C446E7EB7A7D4405F6229E603A3  crates/vault-local-sqlite-vfs-windows/tests/support/mod.rs
```

1. 검증 진입점이 없을 때 테스트가 exit 1로 실패하는 것을 확인했다.
2. 실제 하위 프로세스 종료 코드를 그대로 전달하는 작은 스크립트를 작성했다.
3. 독립 검토 후 명령 검사 대상을 화면의 예정 명령이 아닌 가짜 Cargo의 실제 호출 기록으로 강화했다. 테스트 경로 출력도 따옴표로 감쌌다.
4. Workspace에 문서 예제 검사가 없으면 실패하도록 테스트를 추가했고 `Workspace doctests must run.` / exit 1을 관찰했다. 이후 `--workspace --doc` 단계를 추가해 통과시켰다.
5. 마지막 문서 예제 단계에서만 실패하는 경우도 검사한다. 잘못된 scope, Cargo 누락, `--ignored`/`--include-ignored` 전달은 성공 처리되지 않는다.

## RED 중심 관찰과 BLUE 방어

이번 RED 관점은 검증 결과가 실제보다 안전해 보이는 실패 모드를 줄이는 정적·방어적 검토다. 공격 코드나 외부 시스템 시험은 만들거나 실행하지 않았다.

| 우려하는 실패 모드 | 적용한 방어 / 남은 경계 |
|---|---|
| 옵션을 켠 구성만 검사해 기본 빌드 오류를 놓침 | 기본 구성과 feature 일반 구성을 모두 실행. 기존 feature gate 변경도 재검증. |
| 앞 단계 실패를 뒤 단계 성공으로 덮음 | 첫 실패 즉시 중단, 원래 exit code 보존, 성공 문구 금지. |
| 기록된 예정 명령만 보고 실제 검사했다고 오인 | 회귀 검사는 별도 하위 프로세스가 남긴 호출 marker를 확인. 실제 Rust 검사는 별도 실행. |
| 폴더 이동 후 다른 프로젝트를 검사 | `$PSScriptRoot` 기준 루트와 Cargo.toml 확인, 임시 폴더에서 호출하는 회귀 검사. |
| 일반 검사 성공을 보안 승인으로 확대 | 항상 `PHASE_0A_VERDICT=UNCHANGED`, `REAL_SECRET_GATE=CLOSED`. 명시적 ignored gate 실행 옵션을 받지 않음. |
| 설정 이름 중복을 근거 없이 버그로 분류 | 명세와 기존 테스트를 대조. 현 RecordOnly 모델은 이름+참조 쌍 중복을 금지하며 구현도 일치하므로 확정 버그로 보고하지 않음. |

BLUE 관점의 핵심은 반복 가능한 검사, 실패 상태의 명시, 실제 Secret 금지 유지, 다른 브랜치·정책·작업 보존이다.

## 독립 검토와 미확인 경계

- 다른 에이전트가 검증 스크립트와 테스트 파일을 정적으로 재검토했다. 치명적인 제어 흐름·옵션·경로 문제는 발견하지 못했다. 이는 전체 제품 보안 감사 완료가 아니다.
- MCP binding 이름+field 참조 쌍의 중복 방어는 `2026-08-14-ai-credential-relationship-design.md` 명세 및 `model.rs`, `model_tests.rs`와 일치함을 독립 확인했다. 향후 실행/설정 내보내기에서 이름 단독 유일성이 필요한지는 별도 설계 사항이다.
- 폐기 조합도 명세와 기존 테스트를 추가로 대조했다. 이전 revision의 폐기 확인 규칙은 구현·거부 테스트가 존재한다. 현재 항목의 폐기 상태·폐기 확인·폐기 시각에 적용할 조합 규칙은 읽은 명세에서 명시되지 않아 요구사항 확인 후 판단할 항목으로 남긴다. 교차검증이 없다는 사실만으로 확정 결함이라고 보고하지 않는다.
- ignored Phase 0A 보안 gate, full native VFS/store 통합, 복구 수단, 실제 Secret, 웹/앱/서버 런타임, 동기화, 결제, 공개 배포는 이번에 검증하지 않았다.
- 일반 합성 테스트가 통과해도 과거 Phase 0A Inconclusive를 자동으로 Go로 바꾸지 않는다. 출시/병합 보안 승인은 별도 검토 사항이다.

## 다음 작업

검증된 로컬 변경을 사용자가 검토한 뒤 커밋·푸시 여부를 결정한다. 다음 제품 기능을 추가하기 전 Windows 저장 경계의 권위 검증 계약과 남은 보안 설계를 우선 확정한다. 웹 화면을 만든다면 실제 자격 증명을 받지 않는 합성 데이터 화면으로 별도 범위를 정한다.

## 최종 마무리 기록

- 2026-09-07 03:31 KST: 새 전체 검사 진입점의 직접 실행 종료 코드 0 확인. 기본 검사, feature 일반 검사, 문서 예제, 포맷과 Clippy 모두 통과했다.
- 03:32 KST 점검: 작업 HEAD는 계속 `f85e547b270b3400c924ea8afe9e1f36d846b661`, 별도 main 체크아웃은 깨끗하다. 저장소 내 오늘 변경 6개 파일과 기존 cfg 수정 2개가 미커밋 상태다. 별도 바탕화면 문서 4개도 작성·갱신했다. 커밋·푸시·PR 변경은 하지 않았다.
- 조회된 최근 50개 및 pinned Codex 작업 중 활성 작업은 이 작업뿐이었다. Cargo/Rustc 프로세스는 없었으나 다른 Git 프로세스와 `Welcome - TeamProJect - Visual Studio Code` 창이 관찰됐다. 앞서 Java 언어 서버·Gradle 및 Node 도구도 확인했다. 이 프로세스들은 임의로 종료하지 않았다.
- 다른 편집기의 저장 완료 여부를 비동기 질문으로 확인 요청했으나 이 기록 시점에는 확인 답변이 없다. 안전 조건에 따라 **컴퓨터를 켜 두며, 종료 명령·10분 지연 종료 작업을 생성하지 않았다.**
- `keyatlas-2` 후속 자동화를 PAUSED로 변경하고 실제 설정에서도 확인했다. 오래된 종료 요청이 나중에 실행되지 않도록 했다.
- 당초 03:55 KST를 목표로 잡았으나 현재 범위의 검증 보강을 먼저 마쳤다. 남은 큰 작업은 Windows 저장 경계의 권위 검증·설계 승인 사항이므로 이번에 임의로 시작하지 않는다. 약 2시간을 전부 작업했다거나 전체 제품이 완성됐다고 주장하지 않는다.
