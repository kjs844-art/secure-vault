# M02 submitted demo integration — 2026-09-28

## Scope and provenance

- Target: `keyatlas-mvp-01a-20260927`, branch
  `codex/firstvibe-mvp-01a-integration-20260927`, PR #19; no main merge.
- Starting local/origin SHA: `8119f9b0837e3de808cb4cded87632b76773685f`, clean.
- Submitted source: [M02 PR #21](https://github.com/kjs844-art/secure-vault/pull/21),
  `e19ae37872a1cb2324d4c227593fbf57f8731667`.
- Selectively imported eight `src/components/mvp-demo/` files and
  `src/lib/mvp-demo-data.ts`; source branch/worktree and M02 author's handoff are unchanged.
- Added `/demo`, home navigation, data/render regressions, SSR smoke assertions,
  provenance and verification records. Existing submitted inline layout is reused;
  this is not a new final product design.
- The new M01A-1A catalog-client, M01A-2A loopback QA and M01A-3 PR-ledger owned
  paths are untouched. No manifest, lockfile, dependency, CI, vault/Rust, auth or DB edits.
- DB/domain/hosting/deployment remain held pending explicit user resume. Original
  benefit-validator/Lovable/DB remain frozen. `REAL_SECRET_GATE=CLOSED`.

## Findings fixed before browser acceptance

1. A read-only TypeScript overlay of the submitted code reported ten errors under
   M01A's strict settings (nullable numeric values and an undefined keyboard target).
   Explicit finite/nonnegative amount guards and target checks now handle those cases.
2. Adding unrelated AI requests and coffee coupons produced a misleading total of
   13 uses. The summary now counts services, benefit records and attention items,
   and never sums heterogeneous benefit balances.
3. Attention buttons selected a service without navigating to it. They now focus
   its native button and scroll it into view. Arrow keys wrap selection and focus.
4. Fixed relative expiry calculations and stale fixed source dates. The route supplies
   one serialized reference timestamp for SSR/client calculations; display uses
   Asia/Seoul. Unknown/past expiry requires review rather than a misleading today label.
5. Monthly caps remain distinct from grants/remaining ratios. Unknown and zero are
   not interchangeable. Removed a dead failure/retry path and fixed the benefit typo.

These are integration fixes, not evidence that the author's entire PR failed.
M02's branch and PR remain available unchanged for comparison; no blanket branch merge.

## Exact local checks

Commands below ran in `apps/benefits-web`, except the repository/document checks.

| Command | Result |
|---|---|
| `node --import tsx --test tests/mvp-demo-data.test.ts` | exit 0, 68/68 |
| `node --import tsx --test tests/mvp-demo-render.test.ts` | exit 0, 15/15 |
| `node --import tsx --test tests/mvp-demo-data.test.ts tests/mvp-demo-render.test.ts` | independent recheck exit 0, 83/83 |
| `npm test` | exit 0, 1,253 passed, 0 failed/skipped/cancelled |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0, client/SSR/Nitro output generated |
| `npm run check:boundaries` | exit 0, source 39 / client bundles 8 |
| `npm run test:smoke` | exit 0, 7 assets; `/demo` 200 and catalog route 503 assertions |

The final build/boundary/smoke ran after the last component change (monthly cap
display). The final full unit/typecheck also ran after that change. Generated outputs
and installed dependencies are ignored and are not source changes to commit.

Two independent subagents covered deterministic data regressions and render/source
review. Final read-only review found no additional blocker/important issue within
its scope. This is not a complete security audit or a guarantee of no bugs.

[Browser acceptance](browser-m02-20260928/report.md) adds actual click, keyboard,
focus, navigation and 360px/1280px evidence. It is separate from static rendering.
The router uses session storage for scroll restoration; do not claim zero browser storage.

## Repository/document gate record

- Repo `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1`:
  exit 0, `SECRET_SCAN_PASSED`, synthetic baselines allowed 4, `REAL_SECRET_GATE=CLOSED`.
- Umbrella `scripts/check-markdown-links.ps1 -Root <file>`: each of the seven changed
  Markdown files passed, exit 0. This checks relative targets, not remote URL reachability.
- `git diff --check`: exit 0. Git reports the existing CRLF conversion policy for the
  smoke script; this is not a failing whitespace check.

A scan detects configured patterns; it is not proof of production secrecy.

## Remote evidence and remaining work

The preceding baseline SHA `8119f9b` has completed/success runs
[36369616347](https://github.com/kjs844-art/secure-vault/actions/runs/36369616347) and
[36369612488](https://github.com/kjs844-art/secure-vault/actions/runs/36369612488),
including Rust and both web gates. They do **not** validate this later demo commit.
No active run was cancelled/restarted just because local observation ended.

Remaining: M03 selective review, M04A/M05A evidence reconciliation, delegated
M01A-1A/2A/3 integration, B05 actual-file/new-profile evidence, and provider/account
work once authorized. The whole M01A task, real data connections and public launch
are not complete. Public catalog endpoints remain intentionally unavailable (503).
