# PR 34 isolated review-fix checkpoint

Date: 2026-10-27 KST. Synthetic data only. `REAL_SECRET_GATE=CLOSED`.

## Scope and provenance

- PR baseline: `dd2af499a9243fca5daec720cd46f2875edc1c3c`.
- Main integrated without conflicts: `24971d2cb42012a1fe9eafde574b9d82dcde34c1`.
- Isolated branch: `codex/firstvibe-pr34-review-fixes-20261027`.
- This does not publish the original checkout's 374 dirty paths. Only the explicitly reviewed catalog client, its tests, two UI fixes, and their regression tooling are included.
- Three catalog product files and eight test files were selectively transferred from the previously developed local implementation. The larger catalog view-state/UI, discovery integration, new server modules and other uncommitted work were NOT transferred.
- Existing server/Rust source and catalog index/support adapters remain unchanged.
- Current main Security gates run `40347782965` completed successfully at `24971d2cb42012a1fe9eafde574b9d82dcde34c1`. A direct diff confirms every Rust crate, Cargo manifest/lock, toolchain and workspace verifier is identical between that successful main and this checkpoint. This is evidence for unchanged Rust, not a replacement for fresh PR checks on the changed web files.
- Dependency manifests/locks are the already-merged main changes, not an independent dependency upgrade in this fix.

## Corrective behavior

1. Catalog responses use a bounded reader and a result-only timeout/abort/decoding boundary.
2. Response status, receipt identity, live profile and list/cursor invariants follow the existing server contract.
3. Request values are detached before transport; captured local display context is not server authentication.
4. Replayed operations legitimately load current state, including later revisions and deletion tombstones. Tests preserve this behavior rather than forcing an obsolete profile snapshot.
5. Discovery Inbox actions follow the current input generation; replacing items resets state, while a label-only change preserves edits. Old callbacks cannot edit a replacement generation.
6. The landing page keeps a stable polite, atomic status region and mounts only the active caption.

Independent source review found no must-fix issue in the selected catalog/server compatibility, UI state semantics or new landing CI step. This is not an external security audit.

## Commands and results at this checkpoint

Commands below run from the repository root unless a working directory is specified. All success entries have an observed terminal exit code 0, not merely a running process.

| Check | Command / working directory | Result |
| --- | --- | --- |
| Pre-dependency Secret scan | `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1 -Root .` | PASS; baseline 4; CLOSED; exit 0 |
| Locked dependency preparation | `npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org` in each of `apps/web`, `apps/benefits-web`, `apps/landing` | All three exit 0; original installations untouched |
| Catalog focused suite | `node_modules/.bin/tsx.cmd --test tests/catalog-client.test.ts tests/catalog-client-stream.test.ts tests/catalog-client-contracts.test.ts tests/catalog-client-request-safety.test.ts tests/catalog-client-builders.test.ts tests/catalog-client-scope.test.ts tests/catalog-client-lifetime-resource.test.ts tests/catalog-client-completed-read-cleanup.test.ts` in `apps/benefits-web` | 102 PASS; exit 0 |
| Actual internal HTTP compatibility | `node_modules/.bin/tsx.cmd --test tests/catalog-client-http-compat.test.ts` in `apps/benefits-web` | 8 PASS; exit 0; no external network |
| Final benefits full suite | `npm test` in `apps/benefits-web` | 1,429 PASS; 0 failed/skipped/cancelled; exit 0 |
| Benefits build | `npm run build` in `apps/benefits-web` | PASS; exit 0; existing directive/bundle warnings remain |
| Benefits type check | `npm run typecheck` in `apps/benefits-web` | PASS; exit 0 |
| Benefits boundary | `npm run check:boundaries` in `apps/benefits-web` | PASS; 44 source files / 7 client files; exit 0 |
| Benefits loopback SSR | `npm run test:smoke` in `apps/benefits-web` | PASS; 6 assets; disconnected integration routes retained; exit 0; not browser hydration evidence |
| Discovery focused tests | `npm --prefix apps/web test -- --reporter=dot src/features/discovery-inbox/DiscoveryInboxPanel.refresh.test.tsx src/features/discovery-inbox/DiscoveryInboxPanel.test.tsx src/features/discovery-inbox/discoveryInboxModel.test.ts` | 16 PASS; exit 0 |
| Web full suite | `npm test -- --reporter=dot` in `apps/web` | 63 files / 1,941 PASS; exit 0 |
| Web type check / build | `npm run typecheck`, then `npm run build` in `apps/web` | Both PASS; exit 0 |
| Fresh WASM generation | `scripts/build-wasm.ps1 -SyntheticDemo -Release`, then `scripts/build-wasm.ps1 -Release`, through PowerShell | Both PASS; exit 0; pinned Rust 1.95.0 / bindgen 0.2.128; isolated build cache |
| Actual WASM runtime | `node scripts/test-wasm.mjs`, then `node scripts/test-wasm.mjs --demo` | 40 default / 1,735 demo checks PASS; exit 0 |
| Landing build | `npm run build` in `apps/landing` | PASS; exit 0; existing large-bundle warning remains |
| Landing semantic regression | `node --test apps/landing/scripts/captions.node-test.mjs` | 7 PASS; exit 0; also wired into Security gates CI |
| Actual UI browser | `node scripts/verify-pr34-ui.mjs --synthetic-only` | 13 groups PASS; Chrome 155.0.8059.85; all error counters 0; all owned contexts/browsers/servers closed; exit 0 |
| Diff / runner syntax | `git diff --check`; `node --check scripts/verify-pr34-ui.mjs` | PASS; exit 0 |
| Rust workspace verifier | `pwsh -NoProfile -NonInteractive -File scripts/verify-local.ps1 -Scope Workspace` | Started; format and Clippy PASS. Remaining tests/doctests still running at this checkpoint; NOT reported as a completed pass |

The earlier 1,421 benefits pass preceded the eight HTTP compatibility tests. The final total is 1,429, not an additive second suite.

## RED evidence and test limits

- Catalog: an in-memory characterization of the exact baseline modules failed all seven review-defect assertions (exit 1); the same probe passed all seven against this port (exit 0). It did not swap source files. Cases with multiple assertions stop at the first failure on the old implementation; the focused current suite tests all variants.
- Discovery: the new seven tests on the exact old component yielded four failures / three passes (exit 1). The corrected component passed the 16-test focused suite. Hook tests alone are not React scheduling evidence.
- Landing: the old component failed all seven semantic tests (exit 1); corrected component passed seven (exit 0). An earlier unavailable TypeScript transpiler API was a harness issue, not product RED evidence; the valid comparison used the installed Vite transformer.
- Real browser runner separately mounts actual React components, uses actual landing Scene and native scroll, and checks the accessibility tree. It does not verify audible screen-reader output, every browser/mobile device, or historical native EOF/ERR_ABORTED controls.
- The in-memory browser build is a scoped UI regression, not a deployed-service test. No browser download or user profile was used.

UI source hashes for the successful browser run:

```text
DiscoveryInboxPanel.tsx 78c7f1d5e9301f55ab17dbe147750b0ad37bae5309bfbfad4c81a961e8d6ddfd
landing/App.tsx d9c462b8ad6626f436bd3dcca28ef878c3303ace6e2ffb3b20ba7ae023256d6e
landing/Scene.tsx c70ee2a821a632ec7a93a3a8a150107c8eb66e337c52b0628e46e0f22df21879
```

## Still required before merge / release

- Finish the owned Rust verifier and record its terminal outcome.
- Re-scan the final source/build output and review the exact staged paths.
- Publish only the reviewed checkpoint to the existing PR branch, without force, after checking its current remote head. Fresh exact-head CI must pass before merging PR 34.
- Local Pester 5.7.1 is not available in the current shell; the workflow-policy suite still requires the pinned CI run. No global module was installed to bypass that limitation.
- Do not infer release readiness from this checkpoint. Framework-advisory resolution, the historical browser control anomaly, real authentication/storage/secret gates and the remainder of local product integration are separate work.
- No deployment, real credential input, provider/OAuth connection, payment activation, domain purchase or shutdown occurred.

## Preservation and publication preflight

The original checkout still has 374 dirty paths and zero staged paths. All 1,019 nonignored existing files retain the preflight aggregate SHA-256 `B621FB1FC3795DB1E114971886DEFD850DFC91060E68A972FCB165B4E0DEBA83` (sorted unique relative path + space + uppercase file hash, LF-joined UTF-8). This isolated work has not altered those files.

The final source/build Secret scan returned baseline 4, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`, exit 0. The verification document's relative links and tracked/staged diff checks passed with exit 0.

The scoped fixes may be published as an explicitly pending-validation checkpoint while the unchanged-source Rust verifier finishes; this does not permit merging before fresh exact-head CI. No running check is relabelled as a pass.
