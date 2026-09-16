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
- 깨끗한 checkout에는 없는 `dist` 공개 산출물을 포함하기 위해 웹 build 직후 같은 Secret 검사 protocol을 다시 실행한다.
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

첫 Secret 검사는 `windows-latest`의 외부 검색 실행기나 추가 PowerShell 모듈을 사용하지 않고 PowerShell 5.1/.NET 기본 API만 사용한다. 파일 열거·strict decoding·정규식 실행·SHA-256 계산이 모두 스크립트 안에서 이루어지며 정규식에는 호출당 2초 timeout과 culture-invariant 옵션을 둔다. 재분석 지점, 읽기·열거·디코딩 오류, 구성 파일의 바이너리, 파일당 8 MiB 및 전체 256 MiB·50,000개 파일·100,000개 entry·깊이 64 한계 초과는 실패-폐쇄된다. 300초 cooperative 처리 budget은 read·projection loop에서도 주기적으로 확인하지만 blocking OS call을 강제로 중단하는 hard timeout은 아니며, 외부 hard upper bound는 job의 90분 timeout이다. 일반 바이너리는 printable ASCII와 2/4-byte lane을 검사해 BOM 없는 UTF-16/32 우회를 막고, 파일별 같은 snapshot에서 기준선 hash와 정규식을 적용한 뒤 큰 객체를 해제한다. 이 변경은 runner 제공 검색 바이너리의 provenance 위험을 제거하지만 PowerShell/.NET 런타임과 GitHub runner 이미지 자체의 공급망은 계속 신뢰한다.

## 원격 실행 기록과 아직 검증되지 않은 것

기존 `rg` 의존판 commit `5d439eb`은 GitHub Actions run `35046207820`에서 첫 Secret 단계가 `SECRET_SCAN_FAILED setup_or_execution`, `REAL_SECRET_GATE=CLOSED`, exit `1`로 종료됐다. 의존성 설치·Rust·Node 단계는 시작하지 않았다. 오류 원문과 경로를 출력하지 않는 실패-폐쇄 정책 때문에 그 실행만으로 내부 예외 원인을 단정하지 않는다.

후속 built-in scanner는 로컬 PowerShell 7과 Windows PowerShell 5.1에서 각각 99/99, workflow 구조 정책 9/9, 실제 저장소 scan exit 0을 확인했다.

후속 commit `e400d25`의 [GitHub Actions run `35054302430`](https://github.com/kjs844-art/secure-vault/actions/runs/35054302430)을 확인한 결과, 첫 Secret 검사와 PowerShell 7/5.1 scanner 회귀, Pester workflow 정책 9개는 원격에서도 통과했다. 이후 `Provision the pinned Rust toolchain` 단계가 아래 명령에서 실패했다.

```text
rustup toolchain install 1.95.0 --profile minimal --component clippy rustfmt --target wasm32-unknown-unknown
```

`--component`에 `clippy`만 전달되고 뒤의 `rustfmt`가 별도 toolchain 이름으로 해석되어 `invalid toolchain name: 'rustfmt'` 오류가 발생했다. 이 실행에서 Secret 검사 실패는 재발하지 않았지만, Rust 의존성 준비 이후의 Rust/WASM/웹 검증은 실행되지 않았다.

수정판은 `--component clippy --component rustfmt`로 각 component의 옵션을 명시한다. workflow 정책도 정확한 수정 명령을 검증하고, `rustfmt`를 bare argument로 되돌린 회귀 입력이 거부되는지 확인하도록 보강했다. 로컬 `rustup ... --help`는 수정 명령의 반복 옵션을 받아들였지만, 이는 설치나 원격 실행 성공 증거가 아니다. 수정판의 실제 원격 성공은 후속 run에서 별도로 확인해야 한다.

수정판 로컬 검증은 Pester 3.4.0과 CI와 동일한 Pester 5.7.1에서 각각 workflow 정책 10/10, PowerShell AST 문법 검사와 `git diff --check` exit 0을 확인했다. Pester 5.7.1은 PSGallery에서 프로젝트의 무시되는 `target/verification-modules`에만 저장해 사용했다. 실제 저장소 Secret scan도 `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`, exit 0이었다. 이 결과는 수정판 전체 원격 실행 성공을 대신하지 않는다.

아래 항목은 계속 미검증이다.

- GitHub 호스팅 `windows-latest` 이미지에서 전체 작업의 실제 성공 여부
- 러너가 Rust 1.95.0 및 Node.js 배포 서버에 접근해 설치를 완료할 수 있는지(PowerShell Gallery의 Pester 5.7.1 준비는 위 run에서 통과)
- `npm ci --ignore-scripts` 뒤의 실제 GitHub 러너 웹 빌드 호환성
- CI에서 source-built `wasm-bindgen-cli` 0.2.128과 Rust 1.95.0 조합의 실제 소요 시간 및 호환성
- 저장소 설정에서 이 워크플로를 필수 브랜치 보호 검사로 지정하는 절차

후속판 push는 사용자가 승인했지만, 브랜치 보호 활성화는 GitHub 저장소 설정을 바꾸는 별도 작업이므로 별도 승인 뒤 진행해야 한다.
