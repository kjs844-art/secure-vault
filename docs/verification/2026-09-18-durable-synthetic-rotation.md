# Durable synthetic rotation: implementation and bounded verification

Date: 2026-09-18. Branch: `codex/firstvibe-rotation-staging`.
Base: `bbbe899d4e8750f7aaefb4faf30693b97efb0567`.
`REAL_SECRET_GATE=CLOSED`. This is an implementation checkpoint, not a complete
release/security-gate pass. Local App Control blocks two broad Rust checks.

## 사용자에게 보이는 변화

합성 항목 선택 → 일부 연결처 확인 → 진행만 암호화 저장 → 잠금/새로고침 →
저장한 진행 불러오기 → 나머지 확인 저장 → 새 동의 → 최종 확정을 연결했다.
중간 저장은 현재 키를 바꾸지 않는다. 완료 이력과 중간 후보를 구분하며,
기존 키/이력/후보 암호문은 다시 쓰지 않는다. 실제 공급자 확인·폐기,
실제 키 입력·조회·자동 수집·클라우드 동기화를 구현했다는 뜻이 아니다.

## 구현 구조

```text
SyntheticRotationStagePanel (closed demo choices, new consent each time)
  -> SyntheticVaultSession (display bytes + generation + review receipt)
  -> BrowserSyntheticVaultWorker -> WasmRotationStageAdapter
  -> demo_staging.rs -> archive_staging.rs -> rotation_staging.rs
  <- authenticated fixed projection / encrypted archive candidate
  -> full authentication -> conflict-preserving IndexedDB CAS
  -> exact saved-byte readback -> reauthentication -> publish
```

- Core: opaque `SyntheticRotationStageV1` exposes ciphertext only, with no
  canonical persistence projection. All stages and the final successor are
  siblings of the same canonical base. Inspection authenticates both envelopes,
  reconstructs the exact permitted transformation, and compares full canonical
  CBOR with zeroizing temporary buffers. Required connections and old-key
  revocation remain separate conditions.
- Archive: v4 adds base-index/encrypted-stage entries after the canonical history
  and head map. v1/v2/v3 reads remain. Every inactive stage is authenticated too;
  revision collisions and staging records placed in canonical chains are rejected.
  Existing append/edit/one-shot cutover preserve v4 and all original ciphertext.
- WASM: three new operations exist only under `synthetic-demo`. Inputs are strict
  primitive booleans and bounded integers. Getter-only progress handles reject
  direct construction and become unreadable after lock.
- Web: the old one-shot parser is unchanged; the new stage parser alone accepts
  pending revocation. All stage projections are exact-shape validated and frozen.
  Responses arriving after cancellation/locking cannot repopulate the session.
- Backup: the same complete v4 bytes pass through existing snapshot/empty-store
  restore guards. No new IndexedDB store, plaintext sidecar or cloud write.

The transport framing is not a signed manifest, authenticated ordering, latest
state, rollback, origin, or deletion guarantee. A public demo password means
these fixtures do not protect actual user Secrets.

## Executed checks

Commands are run from the repository root unless noted. Exit 0 means only the
scope shown, not all broader requirements.

| Exact check | Outcome |
|---|---|
| `cargo test -p vault-local-core --lib rotation_staging --offline --locked` | exit 0; 9 passed |
| `cargo test -p vault-local-core --lib rotation --offline --locked` | exit 0; 55 passed |
| `cargo clippy -p vault-local-core --all-targets --offline --locked -- -D warnings` | exit 0 |
| `cargo test -p vault-client-wasm --features synthetic-demo --lib archive:: --offline --locked` | exit 0; 47 passed before one additional test-only case |
| `cargo test -p vault-client-wasm --features synthetic-demo --lib archive::staging --offline --locked -- --test-threads=2` | exit 0; final 12 passed |
| `cargo test --offline --locked --workspace --doc` | exit 0; 7 compile-fail doctests passed |
| `cargo fmt --all -- --check` | exit 0 |
| `pwsh -NoProfile -NonInteractive -File scripts/build-wasm.ps1 -SyntheticDemo -Release` | exit 0; fresh demo WASM built from this source |
| `pwsh -NoProfile -NonInteractive -File scripts/build-wasm.ps1 -Release` | exit 0; fresh default WASM built |
| `node scripts/test-wasm.mjs --demo` | exit 0; 1,528 checks |
| `node scripts/test-wasm.mjs` | exit 0; 40 checks, including no stage exports in default build |
| `npm test -- --maxWorkers=1` in `apps/web` | exit 0; final 41 files / 1,346 tests |
| `npm run typecheck` in `apps/web` | exit 0 |
| `npm run build` in `apps/web` | exit 0; 48 modules, WASM 448.08 kB |
| `pwsh -NoProfile -NonInteractive -File tests/verification/check-repository-secrets.Tests.ps1` | exit 0; 99 passed |
| `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1 -Root <this-worktree>` | exit 0; baseline 4, `SECRET_SCAN_PASSED`, gate closed |
| `git diff --check` | exit 0; line-ending notices only |

Actual-WASM web tests include partial save/fresh-session restoration, completing
saved evidence and cutover, independent-database backup/restore, strict primitive
rejections, lock getters and constructor denial. They use fake IndexedDB and an
inline Worker substitute; the browser evidence below is separate.

## Actual browser / Worker / IndexedDB

Isolated context `keyatlas-stage-20260918`, production preview at loopback port
4181, asset `index-CyZeBJpN.js`, Worker `syntheticVault.worker-Cx5ebBcd.js`, WASM
`vault_client_wasm_bg-Bqnwbsbi.wasm`. No external provider requests were made.

1. Created the three closed fixtures. One preliminary empty stage for reference 0
   was saved while correcting a browser-tool select-label interaction; no real
   user data or invalid ciphertext was introduced.
2. Selected reference 2, recorded MCP=user-confirmed, other connections and old
   key revocation=pending, and saved progress. Actual DB read: v4, 3 canonical
   revisions, 2 stages, 6,408 bytes. SHA-256:
   `65e1a51930a03bd7a2b14dd565d8fe79db17adbc1872ec8699b38a928cc92805`.
3. Reloaded: vault locked and panel absent. Reopened and loaded reference 2:
   MCP confirmation restored, remaining optional=2, revocation pending,
   acknowledgement=false, final commit disabled.
4. Changed CLI to provider-verified (simulated) and revocation to user-confirmed.
   Dirty selection still could not finalize. Saved and loaded again: optional=1,
   ready state, acknowledgement=false, commit disabled until new consent.
5. Explicitly checked consent and double-clicked final commit. Exact stored result:
   4 canonical revisions and 3 stages (one canonical append only), 8,900 bytes,
   SHA-256 `e7e810447c9cfa952afa8f5f5af999aa104cb89a0cfe48cb024ee6bcb40c401d`.
6. Loaded reference 2 again: no active stage for the new head; old stages were not
   reapplied. Consent=false and finalization disabled. Locked the vault and stopped
   only this preview process normally (`q`, exit 0).

All 43 preserved network requests were loopback app/Worker/WASM assets. Console
had one missing `/favicon.ico` 404; no rotation application exception was observed.
This is not a clean-console claim. Mobile, multi-tab browser races, offline,
native file-picker/download round trips, and browser required-pending fixtures
were not exercised here. No screenshot artifact was produced.

## Independent review and corrections

- Archive review found that identity-only history validation could accept a
  staged record reframed as a canonical head. v4 now validates completed rotation
  history on every canonical chain, not just the selected record; partial and
  ready-stage regressions reject that representation.
- Session review found a missing post-parser check for a conflict deletion that
  begins during reentry. The phase/generation check is repeated and a regression
  proves no stage worker or write is started during the in-flight deletion.
- Final independent source review: Critical 0 / Important 0 in the reviewed
  archive/session/WASM boundary, and separately UI/backup/consent boundary.
  This is bounded engineering review, not a professional audit or release approval.
- First TypeScript check caught narrowing of the reentry phase comparison; a
  shared state predicate fixed it. First updated WASM smoke run still used version
  4 as a future version; only those expectations were advanced to 5 and rerun.

The reviewed normalized SHA-256 for `crates/vault-client-wasm/src/archive.rs` is
`43FD2A91A2F43E701ACF6F5F8A0415FB617EAC3185021F835228D38DF16A27A4`.
Only that exact synthetic baseline entry was updated. Scanner patterns, limits,
fail-closed rules and the other three baseline hashes were not changed.

## Explicitly blocked / unfinished

- `cargo clippy -p vault-client-wasm --features synthetic-demo --all-targets
  --offline --locked -- -D warnings`: exit 1, before project lint. Windows App
  Control blocked `wasm_bindgen_macro-2d10af519d0a3f7c.dll`; CodeIntegrity events
  3077/3033 at 07:27:26 confirm it. One elevated retry also failed. No policy,
  exemption, dependency or cache changes were made to bypass the block.
- `cargo test --offline --locked --workspace --tests -- --test-threads=2`: exit 1.
  Compilation completed and bridge catalog 8 tests passed; execution of
  `secret_traits-4fe607db8f15393d.exe` was blocked before running (OS 4551).
  Later workspace suites were not run by that command.
- `powershell.exe -NoProfile -NonInteractive -File
  tests/verification/check-repository-secrets.Tests.ps1`: exit 1 before tests;
  Windows PowerShell 5.1 execution policy denied the script. PowerShell 7 passed.
  No local policy override was applied.
- Thus the new branch does not yet have a full local Rust/legacy-shell security
  gate pass. Its exact remote CI result must be checked after push. The previous
  UI commit `bbbe899` [run 35242399539](https://github.com/kjs844-art/secure-vault/actions/runs/35242399539)
  completed successfully; that result does not validate these new changes.
- Canonical and staged snapshots share 512 revisions / 512 KiB. There is no silent
  eviction, pruning or compaction. A full archive safely refuses further writes,
  including finalization. Reserved-capacity/retention design remains before any
  durable real-user workflow; this limitation must not be hidden as "unlimited".
- Provider authentication, real Secret input, recovery decisions, anti-rollback
  anchors, public deployment, billing, final design and legal approval stay closed
  or user-dependent. The overarching autonomous goal remains active.

Next: obtain exact-branch remote gate evidence without changing local security
policy; then close bounded capacity, browser race/lifecycle and backup-file gaps
before taking on another product capability.
