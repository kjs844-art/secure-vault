# 합성 등록 화면과 private issuer 검색 검증

기준: 2026-09-15, `codex/firstvibe-local-session-hardening`, `52fb776` 이후 변경.
`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`.

이 기록은 가상 계정·키를 선택해 저장하고 다시 찾는 기능의 체크포인트다.
실제 Secret 입력, 외부 계정 자동 조회, 제품 출시 또는 보안 인증 완료를 뜻하지 않는다.

## 구현과 데이터 흐름

```text
열린 금고의 선택형 등록 폼
  ├─ 가상 서비스·계정 프로필 0/1
  ├─ 고정 합성 자격 증명 0
  └─ MCP/CLI/CI 연결 0~3개, 중복 없이 선택 순서 보존
       ↓ 기존 register(selection) 경로
  Worker/Rust 전체 인증 → 기존 암호문 보존 append
       → IndexedDB bytes CAS → 저장본 재읽기·전체 인증
       → 사용자 화면의 목록/검색

암호화 payload의 기존 issuer 필드 4개
  → Rust core → bridge → 잠금/참조 검사된 WASM getter
  → Worker 응답 검증 → 명시적 로컬 snapshot → React 텍스트/로컬 검색
  └─ AI inventory 및 도구 응답(receipt)에는 포함하지 않음

busy/잠금/새 요청 세대 → 폼·검색·로컬 도구 UI 해제
  → 다시 열 때 선택·사용 확인·검색어·필터 초기화
```

- 새 `SyntheticRegistrationPanel.tsx`는 준비된 두 프로필과 연결 체크박스만 받는다.
  실제 키, 비밀번호, 자유 텍스트, 파일 가져오기, 원문 조회/복사는 제공하지 않는다.
- 사용 확인 전과 128개 항목 한도에서 저장 버튼을 비활성화한다. 암호문 512 KiB
  제한과 저장본 인증 후 표시 원칙은 기존 저장 경로를 따른다.
- `LocalVaultPanel.tsx`는 열린 상태와 세대별 key로 폼을 마운트한다. 오류가 발생해도
  이미 저장됐을 가능성을 안내하며, 자동 초기화·재시도나 롤백 성공을 주장하지 않는다.
- issuer 필드는 `issuerAccountIdentifier`, `issuerOrganizationOrWorkspace`,
  `issuerProject`, `issuerEnvironment`다. 암호화 모델/codec/fixture의 형식은 바꾸지 않았다.
- Rust에서 각 필드는 `Option<String>`의 소유권을 이동하고 drop 시 zeroize한다.
  WASM은 `undefined`, JS 로컬 계약은 명시적 `null`로 부재를 표현한다.
- Worker는 누락/`undefined`를 허용하지 않고 `null` 또는 최대 256 UTF-8 byte의
  문자열만 받는다. 빈 문자열과 부재는 구분하여 표시한다.
- 네 필드는 React의 텍스트 노드로 표시하고 로컬 검색에 포함한다. session/tools의
  snapshot은 필드를 명시적으로 복사하며 기존 AI projection은 변경하지 않았다.
- 최소한의 등록 폼 스타일만 추가했다. Claude Code의 최종 디자인 작업을 대신하지 않는다.

## 실행 검사

네이티브와 demo WASM 검사는 같은 Rust 변경에 대해 선행 실행 후 결과를 회수했다.
도구 응답 지연을 프로세스 실패로 취급하거나 같은 실행을 중복 시작하지 않았다.

| 명령/검사 | 결과 |
|---|---|
| `cargo test -p vault-local-core --lib --locked --offline catalog::tests -- --test-threads=1` | exit 0, 3/3 |
| `cargo test -p vault-local-core --test catalog_projection --locked --offline -- --test-threads=1` | exit 0, 1/1 |
| `cargo test -p vault-client-bridge --locked --offline -- --test-threads=1` | exit 0, integration 8/8, doctests 4/4 |
| `cargo test -p vault-client-wasm --features synthetic-demo --locked --offline -- --test-threads=1` | exit 0, 19/19 |
| `cargo clippy -p vault-local-core -p vault-client-bridge -p vault-client-wasm --features synthetic-demo --all-targets --locked --offline -- -D warnings` | exit 0 |
| `cargo fmt -p vault-local-core -p vault-client-bridge -p vault-client-wasm -- --check` | exit 0 |
| `scripts/build-wasm.ps1 -SyntheticDemo -Release` / `node scripts/test-wasm.mjs --demo` | exit 0, 771 checks, 5 catalogs, 54 archive rejections, 3 registrations |
| `scripts/build-wasm.ps1 -Release` / `node scripts/test-wasm.mjs` | exit 0, 기본 export 경계를 포함한 20 checks |
| `npm.cmd run typecheck --prefix apps/web` | 최종 exit 0 |
| `npm.cmd test --prefix apps/web -- --maxWorkers=1` | 최종 exit 0, 17 files, 635/635, 21.42초 |
| `npm.cmd run build --prefix apps/web` | 최종 exit 0, 39 modules |

### 대용량 비교 timeout 원인과 수정

첫 전체 웹 검사는 626 passed/2 timeout이었다. 실패한 기존 백업 테스트는
524,288 byte 경계와 초과 크기 원문 보존의 `Uint8Array.toEqual` 비교였다.
독립 담당자의 임시 계측에서 복원+내보내기 5.37 ms 대 비교 837.53 ms,
초과 크기 거부 0.76 ms 대 비교 810.68 ms로 비교 비용이 대부분이었다.

`SyntheticVaultBackup.test.ts`의 두 비교만 테스트 내부 `Buffer.equals`로 바꾸고
정확한 Uint8Array prototype·길이·byteOffset/byteLength를 함께 검사한다.
해시/일부 표본 비교로 약화하지 않았으며 애플리케이션 코드나 timeout은 바꾸지 않았다.
첫·중간·마지막 byte 변조, 짧은/긴 길이, 서로 다른 offset, 잘못된 typed-array를
검사하는 7개 oracle 테스트를 추가했다. 해당 파일은 92/92, 최종 전체는 635/635였다.
임시 계측 코드는 제거했다.

## 실제 브라우저 증거

격리 Comet 세션의 `http://127.0.0.1:4187/?view=local-vault`에서 가상 데이터만 사용했다.
개인 브라우저 프로필, 외부 계정, 실제 키는 사용하지 않았다.

| 확인한 동작 | 관찰 결과 |
|---|---|
| 초기 잠금/생성 | 잠긴 화면에는 폼/목록 없음; 생성 후 3개, 미확인 저장 버튼 비활성 |
| profile 1, 연결 0개 | 4개로 증가; lab-account/workspace/project/staging이 저장본에 표시 |
| profile 0, MCP 1개 | 5개로 증가; demo-account/workspace/project/demo와 MCP 보존 |
| 연결 해제·재선택 | CI→CLI→MCP 순서 확인 후 CI→MCP→CLI로 재선택 |
| 세 연결 저장 버튼 double-click | 총 6개만 표시; CI→MCP→CLI 순서와 profile 1 정보 보존 |
| issuer 단일 필드 검색 | 계정·workspace·project·환경 각각 lab 항목 2개; demo-workspace는 1개 |
| 조합 검색/빈 결과/필터 | lab-workspace+staging+CI는 1개, 불일치는 0개, 연결 없음 필터도 1개 |
| 선택/검색 후 잠금·재열기 | 폼/목록 제거; 6개 재인증, 검색어/필터/프로필/연결/사용 확인 초기화 |
| 페이지 새로고침 | 잠긴 상태로 시작; 명시적 열기 후 6개 복원 |
| 실제 탭 전환 | about:blank로 이동 후 복귀 시 잠김; 다시 열면 6개와 초기화된 입력 |
| 360×780 viewport | scrollWidth=innerWidth=360; 등록 영역 캡처를 육안 확인 |
| 콘솔/페이지 오류 | Vite/React 개발 안내만 관찰, 앱 경고/페이지 오류 없음 |

Comet의 자동 Perplexity 사이드카가 활성 탭을 가져가 첫 선택자가 실패했다.
로컬 탭을 다시 선택한 후 검증했으며 사이드카의 페이지를 조작하지 않았다.
브라우저 도구의 PowerShell stdin eval이 `null`만 반환한 관찰은 assertion 증거로
세지 않았다. 이후 base64 eval로 DOM 조건과 구조화된 `passed: true` 결과를 확인했다.
시험용 브라우저와 로컬 Vite 서버는 검증 후 종료했다. 별도 오프라인 doctor는
응답이 없어 해당 진단 작업만 중단했으며 앱 실패 또는 진단 통과로 세지 않았다.

## RED 관점: 과신하거나 놓치기 쉬운 경계

- 새 필드가 검색 결과에서 AI/tool 응답으로 흘러가는 경로: getter-no-read,
  직렬화 누출 부재, 고정 receipt 검사를 추가했다. 외부 AI 전달 승인은 아니다.
- 등록 직후 늦은 응답으로 잠금 화면이 다시 열리는 경로: 기존 세대/취소 제어와
  open-only 마운트를 유지했다. 잠금은 이미 진행 중인 저장의 롤백 보장이 아니다.
- 두 번 클릭해 중복 추가하거나 미확인 폼을 제출하는 경로: 사용 확인 gate,
  동기 busy 전환과 폼 제거를 유지하고 실제 double-click의 한 번 저장을 확인했다.
- 계정 정보의 HTML 해석/긴 문자열/빈 값 혼동: React 텍스트, UTF-8 byte 상한,
  null/empty 구분 검사로 방어한다. 브라우저 확장·OS 공격까지 막았다는 뜻은 아니다.
- 공개 fixture 비밀번호, 유효한 과거 archive 복원, collection 누락/위조에 대한
  신뢰 anchor 부재는 여전하다. 합성 암호문을 실제 비밀 보호로 홍보할 수 없다.
- JS 문자열과 브라우저 내부 복사본의 완전 삭제를 보장하지 않는다. 로컬 목록도
  민감 정보이며 외부 AI/디자인 도구로 무심코 전송하면 안 된다.

## BLUE 관점: 유지할 통제

명시적 필드 허용 → 길이/타입 검사 → 로컬 표시만 허용 → 응답 최소화 → 잠금 시
UI 제거 → 원문 보존/CAS/저장본 인증을 유지한다. 독립 정적 리뷰에서 범위 내
blocking/nonblocking 발견 사항은 없었지만, 이는 실행 테스트나 보안 인증을 대체하지 않는다.

## 미검증과 다음 구현

- 네이티브 전체 workspace/SQLite Phase 0A의 별도 보안 gate를 재실행하거나 승인하지 않았다.
- 실제 Android/생체 인증, 디스크 백업 다운로드·네이티브 파일 선택 왕복, 실제 키 입력,
  외부 OAuth·MCP·AI 연결, 서버 동기화·운영 DB·결제·배포는 이번 범위 밖이다.
- 다음은 연결 편집과 회전이다. v2 archive는 모든 envelope를 현재 목록으로 취급해
  같은 record의 successor를 단순 추가하면 중복 record로 거부된다. 과거 envelope를
  교체 삭제하는 것으로 회피하지 말고 immutable revisions와 canonical heads를
  구분하는 저장 계약을 구현해야 한다.
- 먼저 predecessor의 record/expected/parent revision에 묶인 연결 목록 successor와
  무관한 Secret/issuer/notes 보존을 검증한다. 회전 상태의 supersedes와 parent
  관계는 별도 전이 규칙이 필요하다. 현재 row index만으로 편집 대상을 고르지 않는다.
- 전체 사용자 목표는 계속 진행 중이며, 이 체크포인트만으로 완료 처리하지 않는다.
