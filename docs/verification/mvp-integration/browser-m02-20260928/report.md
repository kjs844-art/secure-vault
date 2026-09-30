# Browser Report: KeyAtlas synthetic M02 demo

| Field | Value |
|---|---|
| Date | 2026-09-28 KST |
| App URL | http://127.0.0.1:4317/demo |
| Session | keyatlas-m02-517815006281 |
| Scope | M01A integration of M02: landing/demo/status, keyboard, narrow viewport, synthetic-only display |
| Source revision | 8119f9b plus the M02 integration worktree changes; final commit recorded with the checkpoint |

## Summary

PASS within the bounded browser scope below. Counts cover new browser-observed
findings after integration fixes, not earlier source-review findings or full release
readiness. No account, credentials, mail, DB, or external API was connected.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| Total | 0 |

## Checks

| Check | Observed result |
|---|---|
| Home -> demo -> home | Links navigate correctly; sample service/benefit/attention counts are 4/6/5 |
| Direct `/demo` entry | SSR page hydrates; controls respond; no captured browser errors or console messages |
| Attention button, desktop | AI assistant selected, `aria-pressed=true`, focus on its button, scrollY 1710 and target top 432px in 900px viewport |
| Arrow keys | AI -> coffee -> design -> streaming; ArrowUp wraps streaming -> design; focus and pressed state follow |
| Skip link | Focus is `demo-services`, `tabIndex=-1`, hash is `#demo-services` |
| Desktop | 1280x900 screenshot inspected; no broken layout in the viewed region |
| Narrow viewport | 360x800, light and dark preferences; document width equals 360px, no horizontal overflow |
| Attention button, narrow/dark | Design selected, `aria-pressed=true`, target top 439px in 800px viewport |
| Status route | synthetic, DB/login/Gmail not-connected, external AI/MCP disabled, real secrets CLOSED |
| Re-entry | Selection resets to streaming; no saved account or sample selection restored |
| Runtime observations | No external-origin resource entries on the observed demo document; 0 input/textarea controls |
| Storage | localStorage=0, cookies=0. Session storage starts at 0, then contains router scroll-restoration key `tsr-scroll-restoration-v1_3` (158 characters) after navigation; it contains no sample service names |

The session-storage observation is not a zero-storage claim: the router remembers
scroll positions in the current tab. Demo selection/data are not persisted by this
feature. Resource timing is not a full packet capture or proof of every future path.

## Evidence

- [Home desktop](home-desktop.png)
- [Demo desktop, 1280x900](demo-desktop.png)
- [Mobile light, 360x800](demo-mobile-light.png)
- [Mobile dark, 360x800](demo-mobile-dark.png)
- [Mobile selected service](mobile-selected.png)
- [Earlier default-size demo capture](desktop.png)

The `agent-browser` skill guided snapshot-first interaction, isolated local
verification and explicit evidence limits. Commands used the same config/session
and allowed domain, with fresh snapshots after navigation. PowerShell references
must be quoted, e.g. `click '@e31'`.

```powershell
agent-browser --config docs/verification/mvp-integration/browser-m02-20260928/agent-browser.json --session keyatlas-m02-517815006281 --allowed-domains 127.0.0.1 --content-boundaries open http://127.0.0.1:4317/demo
```

Other exercised CLI operations: `snapshot`, `snapshot -i`, `click`, `press
ArrowDown`, `press ArrowUp`, `set viewport`, `set media dark`, `screenshot`, DOM-only
`eval`, `errors`, `console`, and `close`. Successful interaction batches exited 0.

## Tool limitations and cleanup

- An earlier command context showed `about:blank`; [initial.png](initial.png) is
  retained as tool-context evidence, not an application bug or acceptance screenshot.
  Reopening the exact local URL with consistent config/session/domain flags resolved it.
- `doctor --offline --quick` produced no result and was stopped after several minutes.
  Only its verified owned diagnostic process was stopped; diagnostic exit 1 is not a
  passing environment check. The app and browser remained running for acceptance.
- An unquoted PowerShell `@e31` was interpreted as splatting and yielded a CLI argument
  error. The click was repeated with the quoted reference before recording results.
- Browser session was closed successfully. The owned SSR preview was stopped with
  Ctrl+C; its interrupt exit was 1. A later listener check found no listener on 4317.
- Real devices, assistive technology, Firefox/Safari, formal WCAG contrast, arbitrary
  dates during an open session, API/auth/DB persistence, and public deployment were
  not tested. Empty/error components are covered by render tests, not injected here.

## Issues

No new reproducible application finding was observed within this bounded check.
Earlier code/type findings and their fixes are recorded in
[the integration report](../2026-09-28-m02-demo-integration.md).
