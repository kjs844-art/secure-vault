# KeyAtlas 작업 경로와 Git 현재 상태

확인 시각: 2026-08-31 01:45 KST

## 실제 작업 저장소

- 로컬 경로: `C:\Users\USER\Desktop\secure-vault-sqlite-store-design`
- GitHub 원격: `https://github.com/kjs844-art/secure-vault.git`
- GitHub visibility: `PRIVATE` (2026-08-31 읽기 전용 조회)
- 현재 브랜치: `codex/firstvibe-sqlite-store`
- 로컬 HEAD: `f85e547b270b3400c924ea8afe9e1f36d846b661`
- 원격 추적 ref: `f85e547b270b3400c924ea8afe9e1f36d846b661`
- upstream: `origin/codex/firstvibe-sqlite-store`
- 상태: working tree clean, 로컬과 원격 기능 브랜치 일치
- Draft PR: `https://github.com/kjs844-art/secure-vault/pull/1`
- PR 방향: `main` ← `codex/firstvibe-sqlite-store`
- PR 상태: Open, Draft, 병합 안 됨
- GitHub 보호 규칙: branch protection/rulesets 조회가 현재 private 저장소 플랜 제한으로 HTTP `403`이어서 기술적 강제 보호를 확인하지 못함. 현재 병합 금지는 Draft 상태와 문서화된 사람의 gate에 의존한다.

위 원격 SHA와 PR HEAD는 push 및 GitHub PR 조회로 확인했다. `83bf555`는 Smart App Control `4551` 근본 원인 문서를 추가했고, 새 HEAD `f85e547`는 제품 가이드에 증거 기반 Ready/병합 gate를 명시했다. 둘 다 코드 변경이 아니다. Draft PR 생성은 `main` 병합이 아니다. GitHub 설정으로 강제되는 branch protection은 이번 조회에서 확인되지 않았으므로 Ready 전환과 병합을 수동으로도 금지해야 한다.

## VS Code에서 여는 경로

```powershell
code "C:\Users\USER\Desktop\secure-vault-sqlite-store-design"
```

이 명령은 참고용이다. 이번 작업에서는 IDE를 강제로 열거나 프로세스를 종료하지 않았다.

## 핵심 코드 위치

| 역할 | 경로 |
| --- | --- |
| 암호화 primitive와 wire | `crates/vault-crypto` |
| 합성 자격증명 로컬 코어 | `crates/vault-local-core` |
| SQLite 저장소 | `crates/vault-local-store-sqlite` |
| Windows platform 경계 | `crates/vault-local-platform-windows` |
| Windows Phase 0A 격리 probe | `crates/vault-local-sqlite-vfs-windows` |
| retained writable mapping 소유자 | `crates/vault-local-sqlite-vfs-windows/src/windows_mapping_probe.rs` |
| 실제 handle guard | `crates/vault-local-sqlite-vfs-windows/src/file_guard.rs` |
| hard gate와 대조군 | `crates/vault-local-sqlite-vfs-windows/tests/actual_handle_feasibility.rs` |
| SQLite 사전 검사 | `crates/vault-local-store-sqlite/src/preflight_query.rs` |
| RO 검사·인증·RW 승격 | `crates/vault-local-store-sqlite/src/preflight.rs` |
| writable open과 schema | `crates/vault-local-store-sqlite/src/schema.rs` |
| 반환되는 writable store | `crates/vault-local-store-sqlite/src/store.rs` |

## 핵심 문서 위치

| 내용 | 경로 |
| --- | --- |
| 제품·배포 안내 | `docs/PRODUCT_BUILD_AND_DEPLOY_GUIDE.md` |
| MVP 범위 | `docs/MVP.md` |
| 보안 구조 | `docs/SECURITY_ARCHITECTURE.md` |
| 위협 모델 | `docs/THREAT_MODEL.md` |
| 복구 정책 ADR | `docs/adr/0003-protection-key-slots-and-recovery-policy.md` |
| SQLite 상세 설계 | `docs/superpowers/specs/2026-08-17-ciphertext-sqlite-local-store-design.md` |
| SQLite 구현 계획 | `docs/superpowers/plans/2026-08-19-ciphertext-sqlite-local-store.md` |
| Windows actual-handle VFS 정식 설계 | `docs/superpowers/specs/2026-08-29-windows-actual-handle-sqlite-vfs-design.md` |
| Windows pre-existing mapping Phase 0A 구현 계획 | `docs/superpowers/plans/2026-08-29-windows-actual-handle-vfs-feasibility.md` |
| Windows Phase 0A 최종 검증 기록 | `docs/verification/windows-actual-handle-vfs-feasibility.md` |
| Windows Smart App Control 4551 근본 원인 | `docs/verification/windows-smart-app-control-4551-root-cause.md` |
| SQLite 검증 기록 | `docs/verification/ciphertext-sqlite-local-store.md` |

## 현재 구현 수준

### 합성 범위에서 구현된 것

- 마스터 비밀번호 기반 key wrapping과 authenticated encryption
- canonical CBOR 계약과 future/current 구분
- 암호문 SQLite schema
- immutable revisions, heads, CAS, 충돌 보존
- 재시작 후 잠금 해제 흐름
- 잘못된 비밀번호에서 writable open 금지 방향
- future version·손상 데이터 보존 방향
- process-crash 원자성 테스트 자산
- raw type/connection 노출을 막는 compile-fail 테스트 자산
- 합성 파일만 쓰는 격리 Windows Phase 0A probe
- exact 25-byte writable mapping과 offset 24의 `A`→`B` mutation
- creator file handle 종료 뒤 mapping/view만 유지하는 child state machine
- `READY → parent acquire → optional MUTATE → EXIT` 고정 IPC와 20초 hang watchdog
- pre/post control이 있는 명시적 hard gate

### 부분 완료 또는 검증 차단

- actual SQLite main/WAL/SHM 파일 결속
- open→first query 경쟁 방어
- RO→RW 승격 시 동일 file-set/epoch 유지
- Phase 0A 최종 후보의 단일 primitive: gate exit 0, sharing violation 32 관찰
- Phase 0A 권위 체크포인트: mandatory ordinary suite가 library test 실행 전 오류 `4551`/exit 101로 막혀 Inconclusive
- `4551` 직접 원인: Smart App Control `VerifiedAndReputableDesktop`가 unsigned test EXE를 signing-level 미충족으로 차단
- full Phase 0과 전체 workspace 최종 gate: 완전한 exit 0을 주장하지 않음

### 아직 미구현

- 실제 Secret 입력·검색·회전
- Android/Web UI
- Google/passkey 서비스 인증
- Android Keystore/생체 인증 실제 구현
- recovery slot과 신뢰 기기 폐기
- 암호문 sync API와 PostgreSQL
- backup/export 복구 제품 흐름
- 결제와 Free/Pro 권한
- 공개 배포와 앱스토어 등록

## Git 안전 규칙

- `git add .`를 사용하지 않는다.
- 검증된 파일만 명시적으로 stage한다.
- force push와 main 병합은 별도 승인 전 금지한다.
- DB, WAL, SHM, `.env`, 실제 Secret을 commit하지 않는다.
- 기능 브랜치는 원격에 비강제 push됐고 Draft PR `#1`로만 열려 있다. mandatory suite 통과 전 `main` 병합은 금지한다.

## Phase 0A 커밋 지도

| 커밋 | 무엇을 만들거나 고쳤는가 |
| --- | --- |
| `3f08237` | 격리 crate, platform contract, 안정적 비밀 없는 오류 경계 |
| `fe86fe2` | actual-handle guard, retained writable mapping child, fixed frame, hard gate |
| `6f2cec4` | 합성 mutation을 `A`→`B`로 통일, MapView 오류 코드 보존, 초기 I/O marker |
| `e8b29cb` | metadata 기반 길이를 제거하고 25-byte/offset 24 geometry를 두 mapping 단계에 결속 |
| `88fd18f` | primitive Go 관찰과 전체 Inconclusive 판정을 분리한 검증 기록 |
| `83bf555` | Smart App Control `4551` 원인, exact event/hash/signature 증거, 안전한 후속 경로 문서 |
| `f85e547` | 제품 가이드의 현재 상태와 증거 기반 Draft Ready/병합 금지 gate 최신화 |

`file_guard.rs`의 pathname open은 이 작은 합성 primitive probe 안에서만 허용된다. 미래 native VFS에서 pathname fallback을 허용했다는 뜻이 아니다.
