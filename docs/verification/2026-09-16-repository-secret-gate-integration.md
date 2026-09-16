# 2026-09-16 저장소 Secret gate 통합 검증 기록

## 결론

`scripts/check-repository-secrets.ps1`를 추가하고 `scripts/verify-local.ps1`의 Cargo 검사보다 앞에 연결했습니다. Secret 후보, 검사 도구 오류 또는 출력 프로토콜 모순이 있으면 Cargo를 시작하지 않고 실패합니다. 후보 값이나 일치한 줄은 출력하지 않으며 상대 파일명과 파일 수만 보고합니다.

이 결과는 **실제 Secret 입력 허가나 제품 보안 승인으로 해석하지 않습니다**. 현재 제품과 검사는 계속 합성 데이터 전용입니다.

## 구현 범위

- 공급자 고유 토큰 모양, 개인키 헤더, 대문자 환경변수, PowerShell `$env:`, CMD `set`, 소스코드 자격 증명 literal 할당을 검사합니다.
- JSON과 구성 파일 확장자의 API key·Secret·password·token 필드를 검사합니다.
- `.gitignore`로 숨긴 파일과 `dist` 공개 산출물도 검사합니다.
- 정확히 검토된 합성 데이터 파일 4개만 경로와 줄바꿈 정규화 SHA-256이 모두 일치할 때 허용합니다. 한 글자라도 바뀌면 다시 실패합니다.
- 외부 `rg`나 추가 모듈 없이 PowerShell 5.1/.NET 기본 API로 파일을 직접 열거·읽기·검사합니다.
- 저장소 root와 포함된 하위 경로의 재분석 지점을 거부하고 `.git`, `target`, `node_modules`, `coverage`, `.vite`라는 정확한 디렉터리 이름만 제외합니다.
- BOM을 명시한 UTF-8/16/32와 BOM 없는 엄격한 UTF-8만 허용합니다. 일반 바이너리는 printable ASCII와 2/4-byte lane을 검사해 BOM 없는 UTF-16/32 우회를 막고, 구성 파일 바이너리·잘못된 인코딩·읽기·열거 오류는 fail-closed로 처리합니다.
- 파일별 같은 snapshot에서 기준선 hash와 패턴 검사를 끝낸 뒤 큰 객체를 해제합니다. 파일당 8 MiB, 전체 256 MiB, 50,000개 파일, 100,000개 filesystem entry, 깊이 64, 상대경로 4,096자, 300초 cooperative 처리 budget과 정규식 호출당 2초 timeout을 고정합니다. read·projection loop에서도 주기적으로 budget을 확인하지만 OS blocking call을 강제로 중단하는 hard timeout은 아닙니다.
- CI에서는 의존성 실행 전 검사와 웹 build 후 `dist` 포함 재검사를 모두 강제합니다.
- 상위 검증기는 자식 출력 marker, 수량, 상대경로, 중복과 경계 marker를 다시 검증합니다.

## RED 관점에서 발견하고 닫은 우회

- 단일 파일 결과가 문자열로 축약되어 엄격 모드의 `.Count` 접근이 실패하던 문제
- `.gitignore`를 이용한 후보 파일 은닉
- JSON 따옴표 필드명, 접두사형 환경변수, YAML·TOML·INI·dotenv 형식 누락
- `dist` 전체 제외로 인한 공개 번들 누락
- `test...`·`sample...` 접두사를 모두 placeholder로 허용하던 과도한 면제
- 검토된 합성 벡터 경로를 임의 파일의 은신처로 악용할 수 있는 넓은 예외
- 러너가 제공하는 외부 검색 실행기와 그 버전·PCRE2 동작에 대한 공급망 의존
- 바이너리 파일을 검색기가 조용히 건너뛰던 거짓 통과
- 잘못된 UTF-8, 구성 파일 바이너리, 잠긴 파일, 과대 파일, junction을 조용히 건너뛰는 우회
- `process.env.X` 같은 동적 참조를 실제 Secret으로 오인하는 과탐
- 소스코드의 `const API_KEY = "..."`, `const apiKey = "..."`, `let password = "..."` 선언과 셸의 `export API_KEY=...` 누락
- 암호화 PKCS#8·DSA·PGP 개인키 헤더 누락과 검사기 규칙 문자열의 자기 일치 과탐
- PowerShell `$env:API_KEY = "..."`와 CMD `set API_KEY=...`·`set "API_KEY=..."` 누락
- Python 직접 할당, TypeScript `export const`, Kotlin `val`, Rust `let mut`, 객체 속성 literal 누락
- `spring.datasource.password`, `openai.api-key`, `openaiApiKey` 같은 namespace·lower-camel 접두사 누락
- 기준선 파일이 정규식에 더 이상 걸리지 않도록 바뀌면 해시 검사가 생략되던 무결성 우회
- BOM 없는 UTF-16/32의 interleaved NUL 뒤에 토큰을 숨기는 우회
- 모든 파일의 decoded/projected text를 한꺼번에 보관해 메모리를 과도하게 사용하는 경로
- clean CI의 build 전 검사만으로 생성된 `dist`를 놓치는 실행 순서

모든 재현에는 실행 중 임시 폴더에서 조립한 합성 문자열만 사용했고 테스트 종료 시 삭제했습니다.

## 변경 파일

- `scripts/check-repository-secrets.ps1`
- `scripts/verify-local.ps1`
- `tests/verification/check-repository-secrets.Tests.ps1`
- `tests/verification/verify-local.Tests.ps1`
- `tests/verification/verify-fixture-isolation.Tests.ps1`
- `.github/workflows/security-gates.yml`
- `tests/verification/verify-security-workflow.Tests.ps1`
- `tests/verification/fixtures/rg.cmd` (외부 검색 실행기 대역 삭제)
- `README.md`
- `docs/PRODUCT_BUILD_AND_DEPLOY_GUIDE.md`
- `docs/AUTONOMOUS_WORK_STATUS.md`
- `docs/verification/2026-09-16-remote-ci-security-gate.md`
- 이 기록

## 최종 검사 결과

- PowerShell 7 Secret 검사기 회귀: 탐지·비노출·인코딩·바이너리·재분석 지점과 aggregate/file/entry/path/time/regex 경계 실제 초과를 포함해 `99/99`, exit `0`
- Windows PowerShell 5.1 Secret 검사기 회귀: 같은 suite `99/99`, exit `0` (`-ExecutionPolicy Bypass`는 해당 자식 프로세스에만 적용; 기본 runbook은 `pwsh`)
- workflow 구조 정책: build 후 재검사를 포함해 `9/9`, exit `0`
- 실제 저장소 Secret 검사: `SECRET_SCAN_BASELINE_ALLOWED=4`, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`, exit `0`
- 상위 검증기 프로토콜·실패 전파 회귀: `12/12`, exit `0`
- 복사된 fixture 격리 회귀: `2/2`, exit `0`
- `5d439eb` 기능 묶음 기준 `verify-local.ps1 -Scope Workspace`: Secret gate, 포맷, 전체 Clippy, 전체 기본 테스트, 일반 기능 플래그 테스트, 워크스페이스 doctest 모두 통과, exit `0`
- built-in scanner 후속 트리는 위 집중 검사까지 통과했고 전체 Workspace 재실행 및 최종 독립 재검토는 별도 기록 대상

`5d439eb` 전체 검증의 마지막 경계 marker는 `LOCAL_CHECKS_PASSED`, `PHASE_0A_VERDICT=UNCHANGED`, `REAL_SECRET_GATE=CLOSED`였습니다. 후속 집중 검사도 `REAL_SECRET_GATE=CLOSED`를 유지했습니다.

## 남은 경계

- 현재 작업 폴더를 검사하며 삭제된 과거 커밋을 포함한 Git 전체 이력 검사는 아닙니다.
- `target`, `node_modules`, `coverage`, `.vite` 디렉터리는 검사 대상에서 제외됩니다.
- 일반 바이너리의 printable ASCII 표면은 검사하지만 압축·암호화된 내부를 해제하지 않으며 모든 공급자 토큰 형식을 완전하게 탐지하지 않습니다.
- 파일과 디렉터리의 전후 metadata·재분석 지점 변화를 거부하지만, PowerShell 5.1 기본 API는 no-follow 디렉터리 handle을 유지하지 못하므로 동일 metadata로 순간 교체하는 동시 로컬 공격자를 완전히 배제하지는 않습니다. 깨끗한 CI의 첫 검사에는 저장소 코드가 아직 실행되지 않는다는 위협 모델을 사용합니다.
- scanner 자체의 300초는 cooperative 처리 budget입니다. 단일 OS open/read/enumeration 호출이 반환되지 않는 상황의 외부 hard upper bound는 GitHub Actions job의 90분 timeout이며, 로컬 단독 실행에는 별도 프로세스 supervisor가 없습니다.
- 엔트로피 기반 범용 Secret 탐지기나 `gitleaks` 같은 독립 도구를 대체하지 않습니다.
- 정확히 검토된 합성 기준선이 변경되면 별도 검토와 해시 갱신이 필요합니다.
- 기준선 파일과 허용 해시를 한 변경에서 함께 바꾸는 위험은 남아 있으므로 출시 전 CODEOWNERS·브랜치 보호로 보안 검토를 강제해야 합니다.
- Rust 기준선 3개의 값은 이번 작업에서 출력하거나 외부 유효성을 시험하지 않았습니다. 합성 전용이라는 프로젝트 출처 확인은 운영 전 별도 승인 조건입니다.
- 명시적으로 ignored인 Phase 0A 보안 gate는 실행하지 않았고 판정은 `UNCHANGED`입니다.
- 실제 비밀번호, API 키, 복구 키 또는 개인 금고 데이터 입력 금지는 유지됩니다.
