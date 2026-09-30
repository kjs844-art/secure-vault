# M05A synthetic browser QA tooling V2

This is test tooling, **not a completed browser run or release approval**.
It replaces assumptions in [PR #18](https://github.com/kjs844-art/secure-vault/pull/18)
at `e6e5700d5931a1ce37f93f83049e5cc145e46021`; the source PR and its historical
5/5 report remain unchanged. Do not copy that report as a current result.

## Files and responsibilities

| File | Responsibility |
|---|---|
| [qa-core.mjs](qa-core.mjs) | Exact S1–S5 evidence, fixed errors, fresh-context policy, failure exit |
| [synthetic-idb-probe.mjs](synthetic-idb-probe.mjs) | Exact synthetic DB/archive read and version-only upgrade, transaction completion |
| [qa-lifecycle.mjs](qa-lifecycle.mjs) | Node-side deadlines and late owned-resource disposal |
| [local-vault-scenarios.mjs](local-vault-scenarios.mjs) | Explicit create/open/lock actions and bounded DOM/viewport checks |
| [local-vault-qa.mjs](local-vault-qa.mjs) | Local-only launcher, preflight, network boundary, metadata report |
| `*.node-test.mjs` | Offline Node/fake-indexeddb regressions; no actual browser or provider |

## Offline checks — no extra dependencies

From `apps/web`, with the already locked app dependencies installed:

```powershell
node --test tests/mvp-browser/qa-core.node-test.mjs tests/mvp-browser/synthetic-idb-probe.node-test.mjs tests/mvp-browser/qa-lifecycle.node-test.mjs tests/mvp-browser/runner-config.node-test.mjs
```

These are explicit Node tests, separate from the app's Vitest `src` pattern.
They do not invoke Playwright, GitHub Actions or a browser. No workflow, manifest,
lockfile, Rust/vault format, auth/DB adapter or deployment configuration is changed.

## Actual browser run — prerequisites and limits

Only run against an owned, synthetic production preview. The entry requires
an explicit acknowledgement and only accepts `http://127.0.0.1:<port>/?view=local-vault`.
It does not attach to the user's browser, restore authentication or accept a
persistent profile. Each scenario gets a newly created non-persistent context.
Off-origin HTTP requests, non-read HTTP methods and WebSockets are blocked;
service workers and downloads are disabled. No actual credentials are entered.

Both generated default/demo WASM sets must already exist. A permitted full build
and a separately started owned preview are required; this script does not build
or start a server. An approved existing Playwright runtime/browser must be
available for this submitted-script adaptation. It does **not** install them.
Manual browser QA should follow the installed agent-browser workflow.

```powershell
node tests/mvp-browser/local-vault-qa.mjs --synthetic-only
# Use an already running owned preview on a different loopback port if needed:
node tests/mvp-browser/local-vault-qa.mjs --synthetic-only --base-url=http://127.0.0.1:4317/?view=local-vault
```

No `--profile`, `--cdp`, `--restore`, external URL, custom output path or arbitrary
browser executable is accepted. Existing Windows policy/build blocks must not be
bypassed, nor replaced with mock generated WASM. Missing WASM/runtime gives
BLOCKED and never counts as a passing scenario.

## What gets checked

- **S1:** Exact archive `put` quota failure, fixed error UI, full SHA-256 and byte
  count preservation, reload and **explicit stored-archive open**, never create.
- **S2:** Open an editor, lock, check all known private panel roots and related
  controls are absent from the DOM, reload locked, explicitly reopen same archive.
- **S3:** Enter-to-lock and 20 Tab samples outside private controls. Not a full
  accessibility audit or proof of memory erasure.
- **S4:** 360×800 viewport width measurements unlocked/locked. Not actual mobile,
  biometric, screenshot-based visual or touch testing.
- **S5:** Version-only 1→99 upgrade of the exact isolated synthetic DB, then app
  refusal with `incompatible`. No DB/store/record deletion or rewrite. The archive
  and store layout are compared; offline tests additionally preserve sentinel and
  conflict records. This is not general migration rollback or multiwriter QA.

The IDB probe only reads `keyatlas-synthetic-vault-v1` / `bundle` / `archive`.
It rejects missing/corrupt data and never chooses the first similarly named DB.
Requests are not reported successful until their transaction completes. Hashing
happens after transaction completion/connection close. A timed-out committed
upgrade is not described as rolled back.

## Reporting and cleanup

Exit 0 requires all five scenarios and their required observations to pass.
FAIL, missing/invalid evidence, reused context or cleanup failure cannot give 0.
Prerequisite/configuration BLOCKED returns 2; executed failure returns 1.

Reports are created in a fresh OS temporary directory named
`keyatlas-m05a-synthetic-*`, with an exclusive new `report.json`. Keep reports out
of Git. Output contains fixed codes, bounded counts/hashes, local SHA/dirty flag,
Node/Playwright/browser versions and timestamps—not archive bytes, page content,
console dumps, raw errors, mail or credentials. Preserve previous reports.

Host-side deadlines bound setup, scenarios and disposal attempts. A timeout
quarantines further scenarios and initiates closing only the newly owned context;
the owned browser is also closed in final cleanup. Late-created resources receive
best-effort disposal. Promises and a stuck browser protocol cannot be forcibly
cancelled by a timer: `cleanupConfirmed=false` is a failure, not proof that every
browser process ended. No existing user/IDE/browser process is terminated.

The local SHA does not prove the preview's build matches it. Served-build/source
binding, B05 download→new-profile restore, auto-lock timing, JS heap erasure,
benefits/M03 UI, real-provider behavior and production readiness remain outside
this runner's PASS. An actual browser run must retain its own observed evidence;
offline tests cannot stand in for it.

## Current environmental holds

As of 2026-09-29, the local generated WASM is absent and its earlier build was
blocked by Windows Application Control. Actual browser S1–S5 remain NOT_RUN here.
GitHub Actions usage-limit remediation is explicitly on hold: no reruns, billing
changes or security-gate bypass. DB/domain/hosting/deployment and the original
benefit-validator/Lovable/DB remain held. `REAL_SECRET_GATE=CLOSED`.
