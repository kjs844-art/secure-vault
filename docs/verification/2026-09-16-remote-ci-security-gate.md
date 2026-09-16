# 원격 CI 보안 게이트 통합 기록

## 목적

로컬에서만 실행되던 일반 검증을 GitHub의 Windows 호스팅 러너에서도 반복할 수 있도록 하되, 저장소 안에 실제 비밀정보를 넣거나 외부로 결과물을 업로드하지 않는 보안 게이트를 추가했다.

## 구현 경계

- 트리거: `pull_request`, `push`, 수동 실행만 허용한다.
- 권한: `contents: read`만 부여하며 체크아웃 자격 증명은 보존하지 않는다.
- 가장 먼저 실행되는 저장소 명령은 `scripts/check-repository-secrets.ps1`이다.
- Secret 검사 성공 marker와 `REAL_SECRET_GATE=CLOSED`가 각각 정확히 한 번 확인되어야 다음 단계로 간다.
- Secret 검사기 회귀는 PowerShell 7과 Windows PowerShell 5.1에서 각각 실행한다.
- 이후에만 고정 버전 Pester, Rust 의존성, Node.js와 npm 의존성을 준비한다.
- Rust 1.95.0의 `wasm32-unknown-unknown` target과 `wasm-bindgen-cli` 0.2.128을 정확히 지정한다.
- job 전체에 `RUSTUP_TOOLCHAIN=1.95.0`을 고정해 설치만 하고 다른 기본 toolchain으로 검사하는 상태를 막는다.
- 기본/합성 데모 WASM을 Release 모드로 재생성하고 두 경계를 Node에서 각각 실제 로드해 smoke test한다.
- Rust는 `scripts/verify-local.ps1 -Scope Workspace`, 웹은 `npm test`, `npm run typecheck`, `npm run build`까지 실행한다.
- npm lifecycle script는 `npm ci --ignore-scripts`로 차단한다.
- artifact 업로드 단계와 GitHub Secret 참조는 두지 않았다.

## 공급망 고정

사용한 GitHub 공식 액션은 태그가 아니라 40자리 커밋 SHA로 고정했다.

| 액션 | 고정 버전 | 고정 SHA | 2026-09-16 확인 근거 |
|---|---|---|---|
| `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | [공식 릴리스](https://github.com/actions/checkout/releases/tag/v7.0.1), [공식 커밋](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1) |
| `actions/setup-node` | `v7.0.0` | `820762786026740c76f36085b0efc47a31fe5020` | [공식 릴리스](https://github.com/actions/setup-node/releases/tag/v7.0.0), [공식 커밋](https://github.com/actions/setup-node/commit/820762786026740c76f36085b0efc47a31fe5020) |

`tests/verification/verify-security-workflow.Tests.ps1`은 허용 액션과 SHA, 최소 권한, 안전한 트리거, 실행 순서, 필수 Rust/웹 명령, artifact 업로드 금지를 실패-폐쇄 방식으로 고정한다.

`wasm-bindgen-cli`는 외부 실행 파일을 임의로 내려받지 않고 `cargo install wasm-bindgen-cli --version 0.2.128 --locked`로 빌드한다. 버전과 게시 패키지의 lockfile은 고정되지만, 이는 독립적으로 서명된 바이너리와 공개 SHA-256을 대조하는 것과 같지 않다. crates.io 체크섬과 Cargo의 검증에 의존하며 설치 중 제3자 crate 빌드 스크립트가 실행된다는 공급망 잔여 위험이 있다. 이 실행은 저장소 Secret 검사를 통과한 뒤, 읽기 전용 GitHub 토큰과 GitHub Secret 미주입 상태에서만 일어난다.

Pester도 PowerShell Gallery의 정확한 `5.7.1` 버전으로 제한했지만 별도의 파일 해시를 저장소에서 대조하지는 않는다. 따라서 PowerShell Gallery 전송·패키지 검증에 의존하는 잔여 위험이 있다. 장기적으로는 검토한 패키지 해시를 별도 허용 목록으로 고정하거나, 외부 모듈이 필요 없는 독립 정책 검사기로 교체하는 방안을 검토한다.

첫 Secret 검사는 GitHub `windows-latest` 이미지의 `PATH`에 있는 `rg`와 PCRE2 기능에 의존한다. 스캐너는 실행기 부재·비정상 종료·예상하지 못한 출력에서 실패-폐쇄되므로 검사를 조용히 건너뛰지는 않지만, 러너 이미지가 바뀌면 가용성과 정규식 동작이 달라질 수 있다. 현재는 공식 바이너리 해시를 저장소에서 검증하지 않으므로 공급망·재현성 잔여 위험으로 명시한다. 후속 작업에서는 검토한 `rg` 바이너리와 SHA-256을 고정하거나 외부 실행기가 필요 없는 내장 스캐너로 전환해야 한다.

## 아직 검증되지 않은 것

이 작업 시점에는 파일을 원격에 푸시하거나 GitHub Actions를 실제로 실행하지 않았다. 따라서 아래는 원격 실행 전까지 미검증이다.

- GitHub 호스팅 `windows-latest` 이미지에서 전체 작업의 실제 성공 여부
- 러너가 Rust 1.95.0, PowerShell Gallery, Node.js 배포 서버에 접근할 수 있는지
- `npm ci --ignore-scripts` 뒤의 실제 GitHub 러너 웹 빌드 호환성
- CI에서 source-built `wasm-bindgen-cli` 0.2.128과 Rust 1.95.0 조합의 실제 소요 시간 및 호환성
- 저장소 설정에서 이 워크플로를 필수 브랜치 보호 검사로 지정하는 절차

브랜치 보호 활성화와 원격 실행은 GitHub 저장소 설정을 바꾸는 외부 작업이므로 별도 승인 뒤 진행해야 한다.
