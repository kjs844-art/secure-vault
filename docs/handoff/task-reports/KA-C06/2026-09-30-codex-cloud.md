# KA-C06 — synthetic local signup-mail discovery

Implemented a consent-first, bounded metadata scan and a standalone Korean demo.
The user selects synthetic services and a period, reviews the exact scope and
50-header budget, explicitly confirms, and receives minimal service hints for
manual confirmation or false-positive correction. Cancel, disposal, failure,
and five-minute expiry remove the session's owned result references.

This is **LOCAL_VERIFIED for the synthetic first slice**. The overall KA-C06
task is **PARTIAL**, with its shared completion checkbox left unchanged.

## Git and ownership

- Repository: `kjs844-art/secure-vault`; checkout: `/workspace/secure-vault`.
- Branch: `codex/firstvibe-ka-c06-signup-mail-discovery-20260930`.
- Base HEAD: `d9c66661db7d7b66f6453e94e467c424107cba66`.
- The user's follow-up request authorizes committing and pushing this task branch.
  The implementation revision is the commit introducing this report; its exact
  hash and remote push receipt are recorded in the session after publication.
  The checks below apply to the files in the accompanying SHA-256 manifest.
- No PR, merge, public deployment, or live mailbox access performed.
- Existing tracked files, shared mounts, crypto, Worker, storage, CI, manifests,
  lockfiles, shared TODO, and blueprint remain unchanged.
- [Assignment](ASSIGNMENT.md) records the user's request, task source, base, allowed
  paths, and definition of done.

## Changed files

- `apps/web/src/features/signup-mail-discovery/`: permission contract, local scan
  session, pure/SSR regression tests, standalone React panel, CSS, demo entry/icon,
  and the executable browser smoke-check script.
- [Demo entry](../../../../apps/web/signup-mail-discovery.html).
- [Contract](../../../../contracts/local-v1/signup-mail-discovery-v1.md).
- [Synthetic fixture](../../../../tests/fixtures/synthetic/signup-mail-discovery-v1.json).
- This task's assignment, report, browser results, and file digest manifest.

## Validation

| Check | Result |
|---|---|
| `npm test -- --maxWorkers=2 src/features/signup-mail-discovery` in `apps/web` | exit 0; 3 files / **99 tests passed**, none skipped |
| `npm test -- --maxWorkers=2` in `apps/web` | exit 0; 49 files / **1,566 tests passed**, none skipped |
| `npm run typecheck` in `apps/web` | exit 0 |
| `npm run build` in `apps/web` | exit 0; standard Web production build |
| Standalone production entry build from the contract's command | exit 0; HTML, JS, CSS, and same-origin SVG icon emitted |
| `python3 src/features/signup-mail-discovery/verifySignupMailBrowser.py --dist /tmp/keyatlas-ka-c06-demo-dist` | exit 0; **10 browser checks passed** on installed Chromium **151.0.7922.173** |
| `git diff --check` and UTF-8/Markdown/link/ownership checks | exit 0; checked new files as part of the diff |
| Staged-only credential/provider pattern check | exit 0; 17 UTF-8 added files, no findings; repository expressions evaluated with Python, not the native PowerShell scanner |
| PowerShell repository Secret scanner / Windows CI / Rust unit suite | **NOT_RUN**; PowerShell unavailable, no remote CI invoked, no Rust source changed |
| Actual secrets used | **NO**; `REAL_SECRET_GATE=CLOSED` |

The new regression cases cover exact minimal permissions, unsupported providers,
future versions, frozen scope binding and one-time confirmation, pre-consent
non-evaluation, limits, UTF-8 bounds, sender/date filtering, aggregation, empty
results, all-or-nothing malformed input, exception sanitization, no raw metadata
in results, no network/storage/logging, correction, cancellation, expiry, clock
rollback, and cleanup. SSR checks verify the initial boundary, independently of
the real browser interaction checks.

Browser checks cover keyboard preview, disabled scope controls, cancel before
consent, selected-service filtering, confirm/dismiss/reopen, absent raw subject
or sender text, zero browser storage, 390-pixel layout, expiry, and clearing
results. The browser made only **four same-origin static GETs**, with **no API,
upload, external request, console error, HTTP error, or CSP error**. Details are
in [browser results](2026-09-30-browser-checks.json).

Screenshots were inspected in `/tmp/keyatlas-ka-c06-browser-checks/desktop-review.png`
and `mobile-review.png`. The test server and isolated browser were shut down.

## Environment work

Frozen npm dependencies were installed without changing the lockfile. The
existing Web suite required generated WASM, so Rust **1.95.0**, the
`wasm32-unknown-unknown` target, and exact `wasm-bindgen-cli` **0.2.128** were
prepared outside the checkout. The official rustup installer checksum was
verified; Cargo retained registry checksum verification and locked dependencies.
The synthetic release WASM was built and generated into the existing ignored
directory. Generated files and dependencies are not part of the implementation
diff. No placeholder WASM or type declaration was used to make checks pass.

The complete installer was replayed successfully and Web typecheck passed again.
Reusable `install_script` and `start_skill` were saved in the cloud environment
configuration draft (`status=saved`). Network rules, credentials, and repository
settings were not changed. Draft persistence is not publication, deployment, or
validation on a newly created machine.

Playwright's browser download was denied by network policy; the already installed
Chromium supplied the actual browser validation. Online provider documentation
and official GitHub mirrors also returned HTTP 403; that scope review stays open.

## Remaining work

- Actual Gmail/Graph adapters, current API permission review, effective token
  grant checks, source authenticity, bounded pagination, cancellation/revocation,
  and provider rate-limit/error handling are **NOT_IMPLEMENTED / NOT_RUN**.
- KA-C04 and the shared vault screen are separate owner-controlled branches.
  This feature is a standalone production demo and reusable panel; their integration
  and any encrypted evidence persistence remain outstanding.
- Real email/private metadata, actual account signup, OAuth activation, and
  independent privacy/security review were not exercised. Declared scope strings
  are not proof of OAuth permission. Live providers always fail closed here.
- Synthetic hints are not proof of an account. Only explicit user review can
  change confidence, and no account is automatically registered or deleted.
- Dropping JavaScript references does not guarantee secure erasure or immediate
  garbage collection, and does not revoke snapshots retained by external callers.

Next action: integration owner reviews this task branch and the contract, then
coordinates C04/shared-screen integration and a separately approved live-provider
scope. The shared TODO is not an atomic claim or completion record and was not edited.
