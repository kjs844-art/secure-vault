# 2026-09-13 — 합성 관계 / 로컬 저장 체크포인트

작업 저장소: `C:\Users\USER\Desktop\PersonalProJect\KeyAtlas\worktrees\wanted-ai-championship`

브랜치: `codex/firstvibe-wanted-ai-championship`, 시작 HEAD: `d92346e`.
기존 미커밋 변경은 보존했습니다. 기능 구현 종료 시점에는 커밋·push·PR·merge·공개 배포를 하지 않았습니다.
공식 서비스명은 확정하지 않은 KeyAtlas working title입니다.

## 사용자가 보는 기능

합성 금고 만들기 → 이 브라우저에 암호문 저장 → 3개 항목과 연결 관계 표시.
새로고침하면 잠기며, 저장된 합성 금고 열기로 복원합니다. 이미 저장되어 있으면
만들기를 다시 눌러도 덮어쓰지 않고 기존 것을 엽니다. 별도 실제 Secret 입력창은 없습니다.

```text
같은 기기 / 같은 브라우저 프로필 / 같은 origin

React 기능 화면 ── 명시적 create/open ── 세션 제어기
  ↑ 표시용 허용목록                         │
  │ 서비스·이름·관계                       ├─ IndexedDB: 암호문 묶음만
  │                                       │    읽기 / 원자적 최초 생성
  └── 메시지 재검증 ← 일회용 Worker ←──────┘
                          │
                    Rust/WASM
                          │
           기존 암호화 코어 + 레코드 인증
                          │
             catalog projection (키 원문 없음)

표시 예시: 가상 서비스 → API 자격 증명 → MCP / CLI / CI
기존 네이티브 SQLite ── 아직 위 웹 저장소와 연결되지 않음
클라우드 서버/다른 기기 동기화 ── 미구현
```

## 파일별 역할

| 위치 | 이번 역할 |
| --- | --- |
| `crates/vault-local-core/src/catalog.rs` | 관계 이름/유형을 보유하는 로컬 메타데이터 투영, Drop 시 owned 이름 정리 |
| `crates/vault-client-bridge/src/lib.rs` | 레코드 인증 후 관계를 빌려 읽는 네이티브 경계 |
| `crates/vault-client-wasm/src/lib.rs` | 잠금 상태·인덱스 검사 후 관계 getter 제공 |
| `crates/vault-client-wasm/src/archive.rs` | 기존 암호화 envelope의 합성 archive framing/복원 |
| `crates/vault-client-wasm/src/demo.rs` | feature-gated 합성 생성/복원 exports |
| `apps/web/src/bridge/` | WASM getter 허용목록 및 연결 수·유형·문자열 검증 |
| `apps/web/src/storage/SyntheticCiphertextStore.ts` | IndexedDB 한 slot의 암호문 읽기/원자적 최초 생성 |
| `apps/web/src/features/local-vault/SyntheticVaultSession.ts` | 세대 번호로 오래된 결과/잠금 후 재표시 차단 |
| `apps/web/src/features/local-vault/SyntheticVaultWorkerClient.ts` | 새 Worker, 메시지 재검증, 취소/90초 timeout |
| `apps/web/src/features/local-vault/syntheticVault.worker.ts` | WASM 초기화/합성 생성/복원, 핸들 정리 후 종료 |
| `apps/web/src/features/local-vault/LocalVaultPanel.tsx` | 생성·열기·잠금 및 관계 보기, 탭 숨김 자동 잠금 |
| `scripts/test-wasm.mjs` | 실제 생성 WASM의 기본/합성 API 및 archive 오류 경계 검사 |

## 저장 규칙

- DB `keyatlas-synthetic-vault-v1`, version 1, store `bundle`, key `archive` 하나.
- `Uint8Array`만 허용. 양수 크기/512 KiB 상한. plain catalog나 비밀번호를 DB에 쓰지 않음.
- request 성공이 아니라 transaction `complete` 이후에만 저장 성공 반환.
- readwrite 안에서 키 존재 확인 + `add`: 다른 탭이 먼저 만들면 기존 것을 유지.
- 생성 이후 반드시 저장소를 다시 읽어 실제 저장된 암호문으로 복원.
- 손상된 타입·추가 키·미래 DB 버전·스키마·암호문 실패는 자동 복구/초기화 없이 오류.
- 잠금 전 이미 시작된 commit은 끝날 수 있으나 잠금 후 UI 복원은 금지.
- 별도 영구 저장 권한/백업을 요청하지 않음. 브라우저 삭제·공간 회수·기기 손상에 취약.

Archive는 `KATLDEMO` magic, v1, 정확히 3개 레코드와 4개의 길이+envelope로 구성됩니다.
각 envelope 64 KiB 이하, 전체 512 KiB 이하, trailing bytes 불허.
프레임과 모든 envelope 구조를 비밀번호 KDF 전에 검사합니다. 전체 인증·투영이
완료되기 전까지 부분 목록을 UI에 반환하지 않습니다.

## Red/Blue 관점의 현재 경계

| 위협/실수 | 이번 방어 | 남은 한계 |
| --- | --- | --- |
| 잠금 후 늦은 복호화 결과 재등장 | 세대 검사, Worker 종료, UI state 초기화 | JS 외부 복사본/캡처 삭제 보장 아님 |
| 동시에 만들기 → 기존 금고 유실 | 동일 transaction 안의 create-if-absent, 저장값 재읽기 | 편집·충돌 해결·여러 기기 동기화 없음 |
| 손상/미래 버전 때문에 초기화 | 오류 반환, 기존 바이트 보존, 자동 삭제 없음 | 사용자가 브라우저 데이터를 삭제하면 복구 불가 |
| 과대 입력·형식 오류로 무제한 연산 | JS와 Rust 양쪽 bounds, KDF 전 구조 검사 | WASM 직접 호출/악성 same-origin JS의 통제를 보장하지 않음 |
| 키 원문이 UI·로그로 섞임 | 비밀 getter 없이 표시 메타데이터만 복사, 고정 오류 코드 | 관계명/서비스명 자체도 민감. AI/분석 제공 금지 |
| 유효 archive를 최신/신뢰 데이터로 오인 | 문서와 UI에서 합성 전용을 명시 | 공개 비밀번호, 전체 manifest/출처/완전성/rollback 보장 없음 |

**공개 고정 테스트 비밀번호이므로 실제 비밀정보 기밀성은 제공하지 않습니다.**
누군가 앱을 확보하면 이 데모 archive를 열 수 있습니다. 암호화 성공과 실제
사용자 인증 성공은 다른 개념입니다. 현재 unlock은 인증 UX 시연이 아닙니다.

## 이번에 실행한 검사

- 웹 `npm run typecheck`: exit 0.
- 웹 `npm test`: 최종 165/165 통과 (파일 5개, 2026-09-13 13:23 KST).
- 웹 `npm run build`: exit 0, Worker와 WASM asset 포함. 공개 배포하지 않음.
- `cargo test -p vault-local-core --test catalog_projection --locked --offline`: 1/1 통과.
- `cargo test -p vault-client-bridge --test catalog_snapshot --test secret_traits --locked --offline`: snapshot 7/7 + compile-fail harness 1/1 (13개 거부 사례) 통과.
- `cargo test -p vault-local-core --lib catalog::tests::every_consumer_type_maps_to_its_allowlisted_catalog_type --locked --offline`: 1/1 통과.
- `cargo clippy -p vault-client-wasm --target wasm32-unknown-unknown --all-features --locked --offline -- -D warnings`: exit 0.
- `scripts/build-wasm.ps1 -SyntheticDemo`, 기본 build: 둘 다 debug WASM 생성 exit 0.
- `node scripts/test-wasm.mjs --demo`: 347 checks, catalogs 2, archive reject cases 23, exit 0.
- `node scripts/test-wasm.mjs`: 기본 exports 검사 9 checks, exit 0.
- `cargo fmt --all -- --check`: exit 0.
- `git diff --check` 및 새 문서 2개의 trailing whitespace/code-fence 검사: exit 0.
- 실제 Codex Chromium 브라우저: 빈 상태 → 생성 → 3개 관계 표시 → 새로고침 후 잠김 → 저장된 금고 열어 동일 3개 관계 복원 확인.
- 실제 브라우저: 복호화 처리 중 잠금 버튼에 응답, 관계 목록 제거 확인.

## 미검증 / 차단 사항

- `cargo test -p vault-client-wasm --features synthetic-demo --lib --locked --offline`는 Windows Application Control OS error 4551로 build-script 실행 전 차단, exit 1. 새 archive native unit tests 10개를 통과했다고 주장하지 않음. 실제 WASM runtime 검사는 별도 증거.
- Windows 보안 정책을 끄거나 차단을 우회하지 않았음. release profile 재검증 안 함.
- OS 강제 종료·전원 차단·브라우저 전체 재시작 후 내구성, 실제 용량 부족, 실제 미래 DB 마이그레이션, Firefox/Safari/모바일 기기: 미검증. fake-indexeddb tests는 시뮬레이션 증거.
- 실제 비밀번호/키, 생체인증·패스키·복구, 키 회전, 원문 보기·복사, 전체 레코드 manifest, 클라우드 동기화: 미구현/개방 안 함.
- IndexedDB 원시 디스크·브라우저 WAL 전체 평문 검사, XSS/supply-chain 안전성, 프로덕션 보안 감사: 완료 아님.

다음 기능 후보는 합성 전용 편집/연결 관리와 암호화 백업·복구 왕복 검증입니다.
실제 Secret 개방은 공개 데모 비밀번호 제거, 사용자 소유 키·복구 정책, origin/배포 보안,
독립 보안 리뷰가 먼저입니다.

참고: [MDN IndexedDB 완료 이벤트](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event),
[MDN 저장소 격리·제거 조건](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

## 사용자 승인 후 push 전 재검사 (13:32 KST)

- 사용자가 현재 작업을 GitHub에 push하도록 승인. 대상은 비공개 `kjs844-art/secure-vault`의 현재 기능 브랜치이며 main 병합/강제 push/공개 배포는 범위 밖.
- 소스·문서·테스트·lockfile 92개, 합계 약 343 KB를 점검. 알려진 credential 정규식 일치 없음. 실제 DB·env·생성된 WASM·실행 파일·node_modules·dist는 후보에 없음. 패턴 검사는 모든 비밀정보 부재의 증명은 아님.
- 기본 `npm test` 재검사에서 oversized IndexedDB 보존 사례 1개가 5초 시간 제한을 초과하여 exit 1. 같은 테스트 단독 실행은 exit 0, 전체 `npm test -- --maxWorkers=1`는 165/165, exit 0.
- 이어서 `npm run typecheck`, `npm run build` 모두 exit 0. 시간 초과를 숨기거나 production-ready 판정으로 바꾸지 않음.
- 독립 읽기 전용 검토에서 잘못된 과거 README 설명 두 곳을 수정: React의 실제 WASM 연결과 private 관계 이름 투영 범위.
- 앞서 기록한 Windows Application Control 4551/native unit test 미검증 조건은 그대로 유지.
