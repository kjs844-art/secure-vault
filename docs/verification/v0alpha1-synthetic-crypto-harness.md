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
