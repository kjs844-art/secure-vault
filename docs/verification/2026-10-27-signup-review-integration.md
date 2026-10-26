# Synthetic signup discovery into same-session review

Date: 2026-10-27 (Korea). Base: `11a7148a5d68dbcf9747a93b31be3763a8c06849`.
`REAL_SECRET_GATE=CLOSED`. This is a synthetic demonstration, not live mailbox
discovery or verification of account ownership.

## User-visible behavior

The web home links to `/?view=signup-mail-discovery`. A user selects allowlisted
example services and a 7/30-day fixture range, previews the exact scope and
explicitly consents before scanning the synthetic metadata. Only coarse service,
signal and date evidence enters the same session's controlled review list.
Confirm, needs-review and dismiss are review labels, not an account assertion.

No live provider, OAuth, body/attachment input, network analysis, vault import,
browser persistence or automatic registration action is added. Empty results
remain empty instead of falling back to the standalone inbox fixture. The
existing standalone inbox and its refresh regression remain unchanged.

Cancellation, reset, reload, unmount, page departure and expiry remove the
current UI candidates/classifications and require a fresh consent flow. The
five-minute lifetime starts at preview creation and is not extended by review or
filter actions. Session access checks expiry; scheduled DOM removal remains
subject to browser scheduling. This is not cryptographic erasure of all copies.

## Selective integration and review

Thirteen new product/test/fixture files were initially copied with exact SHA256
agreement from the preserved original checkout. Twelve protected target files
were unchanged at that point. Root then connected only the signup route and home
link; original unrelated demo routes, dependency files and Rust files were not
overlaid. Main's newer Vite/Vitest versions and existing C04 refresh tests remain.

Independent review and regression work refined same-session action identity and
focus handoff before publishing. A parent callback regression reproduced two
failures; a separate child action/focus regression reproduced four. Each was
then corrected without changing session lifetime or consent scope. Those are
callback/hook-model tests, not direct DOM exploit demonstrations. Native focus
and navigation evidence is separately listed below.

The consent-patterns review informed narrow, explicit scope, revocation and
session-bound lifetime. It is not an external security audit or release approval.

## Current checks

| Check | Outcome |
| --- | --- |
| Initial selective-port focused suite | 7 files / 146 PASS, exit 0 |
| Parent callback regression, before fix | 12 PASS / 2 FAIL, exit 1 |
| Parent fix plus app/related tests | 8 files / 150 PASS, exit 0 |
| Child focus/action regression, before fix | 9 PASS / 4 FAIL, exit 1 |
| Child fix plus parent/model focused suite | 3 files / 46 PASS, exit 0 |
| Final full web suite | 69 files / 2,087 PASS, exit 0 |
| TypeScript plus final production build | exit 0, Vite 8.3.4 |
| QA lifecycle helper | 17 PASS, exit 0 |
| Runner syntax and 9 CLI cases | expected exits 0/2; verification wrapper exit 0 |
| Actual Chrome 156.0.8078.48 | 11 groups PASS, exit 0, 20:43:32–20:43:48 UTC |
| Actual Edge 156.0.4314.42 | 11 groups PASS, exit 0, 20:44:26–20:44:37 UTC |
| Owned UTF-8/newline/whitespace/conflict-marker checks | 21 files PASS, exit 0 |
| README/report relative links and diff whitespace | exit 0 |
| Final Secret scan | Baseline 4, PASSED, CLOSED, exit 0 |
| Independent final runner/document review | No blocking finding; limits below retained |
| Rust workspace verifier | Running at this record's initial write; not yet claimed successful |
| Exact-head GitHub CI | Not yet run for this change |

Both actual browsers checked selected scope/keyboard preview, cancel, same-session
classifications and filter focus, absence of raw fixture text/browser storage,
360/320px overflow, clear/reset, reload/remount, and the actual built-app route.
Each observed four native same-document BFCache paths: reviewed/pending consent
in the fixture and in the built app. Success requires an unchanged marker and
trusted persisted lifecycle events with empty event-time UI. A reload or absent
BFCache would be INCONCLUSIVE, not silently accepted as native restoration.

All seven counters were zero in both runs: page, console, external request, HTTP,
failed request, denied request and server errors. Context/browser/server close
promises resolved, browser disconnected, server stopped and zero owned sockets
remained. The runner emits final status only after cleanup, keeps any deadline
failure and does not force-kill browser processes. No user browser/profile was
attached. Built index SHA256 in both runs:
`6b5b31e754c4b84833924a3365fda1c89d70376f3cffd679d50d30180b56161f`.

This is the C06 flow. Its success does not repair or supersede the separate #44
native transport failures, #45 Chrome close failure, or #42 timing uncertainty.

## Commands

From `apps/web`:

```powershell
npm test
npm run typecheck
npm run build
```

From the repository root:

```powershell
node --test apps/web/tests/mvp-browser/qa-lifecycle.node-test.mjs
node apps/web/scripts/verify-signup-mail-review-browser.mjs --synthetic-only --built-app --channel=chrome
node apps/web/scripts/verify-signup-mail-review-browser.mjs --synthetic-only --built-app --channel=msedge
pwsh -NoProfile -NonInteractive -File scripts/verify-local.ps1 -Scope Workspace
```

## Changed paths and limits

- `apps/web/src/features/signup-mail-discovery/` (10 new files).
- `apps/web/src/features/discovery-inbox/DiscoveryInboxReview.tsx` and its test.
- `tests/fixtures/synthetic/signup-mail-discovery-v1.json`.
- `apps/web/src/App.tsx`, `App.test.tsx`, `main.tsx`, and `apps/web/index.html`.
- `apps/web/scripts/verify-signup-mail-review-browser.mjs` and its fixture.
- README and this note.

Expiry browser checks use a separately mocked clock, not a real five-minute
measurement. Actual phones, Firefox/WebKit, screen readers, OS sleep, real mail,
provider authentication and deployment remain unverified. Index hash is not a
source-to-build attestation. No dependency install, original checkout mutation,
design decision, database/domain/payment activation or computer shutdown occurred.
Fixture build and page creation do not have an additional runner-owned deadline;
do not describe every operation as bounded. The runner does not call a process
force-kill API; this is not a claim about all internal Playwright close fallbacks.
