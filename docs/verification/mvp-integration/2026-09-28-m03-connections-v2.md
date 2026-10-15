# M03 synthetic connection contract V2 — 2026-09-28

## State and source

- Target checkout: `keyatlas-mvp-01a-20260927`; branch
  `codex/firstvibe-mvp-01a-integration-20260927`, existing PR #19, no main merge.
- Start local/origin HEAD `b98ea7a5dc45d40f67d395238ecfd4fdfd360af6`, clean.
- M03 [PR #17](https://github.com/kjs844-art/secure-vault/pull/17) source tip
  `5fecb0f29ce56b2959b5350913247114ded8e8cf` live-checked and fetched.
  Unique diff versus `34b43e1` is three files, not its full main-relative PR diff.
- The reviewed public enum/reference concept is adapted into a strict independent
  V2 under `apps/web/src/features/mvp-connections/`; original branch/PR is unchanged.
- No existing V1 consumer was found in this checkout. No auto-migration, Rust/vault
  protocol change, bridge import, live endpoint, UI mount, actual credential or account.
- M01A-1A/2A/3 reserved paths and other worktrees remain untouched. All infrastructure
  holds and original Lovable/repo/DB freeze remain. `REAL_SECRET_GATE=CLOSED`.

## Why the submitted contract was not wired unchanged

Read-only independent review confirmed these integration gaps:

- A 64-character arbitrary note could carry private text despite a no-secrets claim.
- A caller could supply `verified`; source/observation time were missing entirely.
- A numeric range check did not establish snapshot membership or key/service relation.
  No destination identity distinguished two MCP targets for the same key.
- Some reflection failures escaped fixed-error handling; validated descriptors were
  followed by ordinary property reads rather than copied descriptor values.

V2 removes arbitrary text and caller-declared verification, validates an exact
detached context, derives provider/usage, retains source and nullable observed time,
and evaluates freshness with an explicit clock/policy. Separate exact-instance local
confirmation preserves unknown/stale evidence and never claims provider/auth proof.

Independent review during implementation additionally found close-during-inspection
and repeated-confirmation freshness rollback cases. Rechecks before issuance (including
empty batches), last confirmation time and cumulative minimum max-age now cover them.
Focused regressions pass and the reviewer confirmed both corrections. That targeted
review found no further important issue in scope; it is not a complete security audit.

Contract/API/limits: [M03 V2 README](../../../apps/web/src/features/mvp-connections/README.md).

## Executed local checks

In `apps/web` unless otherwise specified:

| Command | Actual result |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | exit 0; 49 locked packages; no manifest/lock changes |
| `npm test -- src/features/mvp-connections/mvpConnectionReference.test.ts` | exit 0; 211/211 |
| `npm test` | exit 1; 43 files pass / 7 existing WASM suites fail to load; 1,653 loaded tests pass |
| `npm test -- --exclude '**/*.wasm.test.ts'` | exit 0; 43 files / 1,653 tests; explicitly partial |
| `npm run typecheck` | exit 1; 8 TS2307 generated WASM imports missing; no V2 source/test errors in final output |
| `npm run build` | exit 1 at the same typecheck; Vite bundling not reached |
| Focused strict TypeScript command below | exit 0; the two V2 files only, not the project build |

```powershell
npm exec -- tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck --isolatedModules --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM --types vitest/globals src/features/mvp-connections/mvpConnectionReference.ts src/features/mvp-connections/mvpConnectionReference.test.ts
```

The first focused compiler invocation omitted `--ignoreConfig` and exited 1 with
TS5112 (TypeScript 7 requires that flag for explicit files beside tsconfig). The
corrected explicit-file invocation above passed. The project config was not changed.

Repo-root attempts:

- `pwsh -NoProfile -NonInteractive -File scripts/verify-local.ps1 -Scope Workspace`:
  exit 1. Secret scan and `cargo fmt --all -- --check` passed. `cargo-clippy` was
  blocked by Application Control (`os error 4551`); later Rust tests/doctests did not run.
- `pwsh -NoProfile -NonInteractive -File scripts/build-wasm.ps1 -SyntheticDemo`:
  exit 1. Pinned tool version check succeeded and compilation started; Windows blocked
  the wasm-bindgen build script before execution (`os error 4551`). No generated JS/WASM.
- No policy changes, unblocking, renaming/rebuilding tools to evade policy, substitute
  WASM bindings, or test/workflow skip edits. Target output and node_modules stay ignored.

The focused/non-WASM successes are useful but do not erase full-build failures.
This checkpoint is suitable for further integration review, not release certification.

Final repository/document gates:

- `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1`:
  exit 0, `SECRET_SCAN_PASSED`, baseline 4, `REAL_SECRET_GATE=CLOSED`.
- Umbrella `scripts/check-markdown-links.ps1 -Root <file>`: all six changed Markdown
  files passed separately, exit 0; relative-file links only, not external reachability.
- `git diff --check`: exit 0. Generated/installed files remain ignored; reviewed
  source and documentation are explicitly staged, not the umbrella or other checkouts.

## Remote evidence

Preceding M02 commit `b98ea7a` runs
[36372171670](https://github.com/kjs844-art/secure-vault/actions/runs/36372171670) and
[36372166803](https://github.com/kjs844-art/secure-vault/actions/runs/36372166803)
are terminal failures with **no job steps**. Their annotations report failed account
payments or a spending limit needing attention. No settings/payment/retry was changed.
That is infrastructure-blocked remote validation, not a tested code failure.

This V2 change's eventual push/CI outcome must be checked by its own SHA; neither
the previous failure nor an older successful SHA is its validation evidence.

## Remaining / not verified

- Full Rust/Clippy/WASM and complete app typecheck/build in a permitted environment.
- New-SHA GitHub CI once account execution is available; don't infer which billing
  condition applies without the account owner's settings.
- Actual UI interaction, actual provider/account discovery or key validity,
  auth/view ownership, lock wiring, storage, cross-origin transport and deployment.
- Adapter mapping real benefit IDs and vault generations/revisions; synthetic
  references must never be persisted or directly substituted for real identities.
- M04A/M05A evidence review, B05 actual-file/new-profile proof and the delegated
  1A/2A/3 work are separate. M01A as a whole remains IN_PROGRESS.
