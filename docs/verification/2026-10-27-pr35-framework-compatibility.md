# PR35 framework compatibility checkpoint

Recorded 2026-10-26 UTC / 2026-10-27 Korea. Synthetic data only;
`REAL_SECRET_GATE=CLOSED`. This is a local verification checkpoint, not a release
approval or a claim that every browser check passed.

## Scope and provenance

- Original PR35 head: `75acfaae9e513d60531b1d80704ddd394bf76f15`.
- Integrated reviewed PR34 head: `eaa163ffe4a4f873c6e3b65a92a4258c1da3d15f`.
- PR34 was subsequently merged as main `06d19cccec44d899778202c6edb38489c2ef674d`.
- Relative to the reviewed PR34 tree, direct Start changes from `1.168.32` to
  `1.169.3` and Router from `1.170.18` to `1.170.45`. The latter matches Start's
  exact dependency. Router core resolves to `1.171.38`; server core to `1.169.44`.
- Vite `8.3.5`, Zod `4.6.7`, React, Nitro and TypeScript remain unchanged.
- The lock was regenerated against the public npm registry with lifecycle scripts
  disabled. No overrides, peer-dependency bypass, audit fix or original shared
  installation changes were used.
- Independent review matched all 23 changed-present package records to official
  registry metadata. No must-fix was found in the scoped manifest/lock/test diff.
  This does not constitute a full dependency source audit.

## Checks on this exact candidate

Commands below run in `apps/benefits-web` unless a root path is shown.

| Check | Exact command / result | Exit |
| --- | --- | --- |
| Pre-install Secret scan | Root: `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1 -Root .`; baseline 4, CLOSED | 0 |
| Install | `npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org` | 0 |
| Actual installed graph | `npm ls @tanstack/react-start @tanstack/react-router @tanstack/router-core @tanstack/start-server-core vite --all`; coherent/deduped core pair | 0 |
| Full unit suite | `npm test`; 1,436 passed, 0 failed/skipped/cancelled | 0 |
| New graph regressions | 7 cases in `tests/framework-compatibility.test.ts`, included in full suite; nested stale copies, aliases and transitive drift rejected | 0 |
| Fresh production build | `npm run build` including TypeScript; existing module-directive and bundler debug-name warnings remain | 0 |
| Final typecheck | `npm run typecheck` after the new test file | 0 |
| Source/client boundary | `npm run check:boundaries`; source 44 / client 6 | 0 |
| Actual loopback SSR | `npm run test:smoke`; assets 5 | 0 |
| Production dependency advisory check | `npm audit --omit=dev --registry=https://registry.npmjs.org`; 0 known vulnerabilities at check time | 0 |
| All dependency advisory check | `npm audit --registry=https://registry.npmjs.org`; 0 known vulnerabilities at check time | 0 |
| Chrome actual built framework | Existing isolated runner with `--synthetic-only --build-root` targeting this fresh build; Chrome 155.0.8059.85, 42/42 groups, errors 0, cleanup true | 0 |
| Edge actual built framework | Edge 156.0.4314.42, 42/42 groups and errors 0, but `BROWSER_CLOSE` deadline; overall FAIL retained | 1 |
| Independent blank-page Edge control | Same installed tool/browser and unchanged 10-second cleanup helper, no app/server/CDP loaded; close deadline reproduced | 1 |

The external runner was used read-only from the existing isolated framework
snapshot, not copied into this candidate or assumed to validate its older build.
Its invocation is `node scripts/verify-framework-server-boundary.mjs
--synthetic-only --build-root <absolute candidate apps/benefits-web>` from that
snapshot's benefits folder, with `BROWSER_CHANNEL=chrome` or `msedge`.
No browser was downloaded. Each owned run was completed before the next began.

## Evidence identity

| File | SHA-256 |
| --- | --- |
| package.json | `C5C768F4CC69E23A634DCAFC2B68ADABDFDB06B455F0BF766B19C64E7AC91BED` |
| package-lock.json | `EB5E7729113AF650C1825954F99168134BB8BCD4751779B16FA5E37A02D8D438` |
| tests/framework-compatibility.test.ts | `A2416CF5EFD0FCD9DAC4BB2139F5E8F7D4B53BAC3250F2766BA37FC0D0635CC0` |
| .output/server/index.mjs | `01F4727D78C723B7C2098D4606B3F346F9BA32EBB1A44007697BA0CB5F4C3211` |
| .output/server/_ssr/ssr.mjs | `EC053822C7CBA7C365F7BAAF26C3106CCB8434470BFB586708E0C01C2891A9C4` |

## Open limits and publication boundary

Edge disconnected in 83.289 ms in the application run, but its close operation did
not resolve within 10 seconds. The independent blank-page control also timed out
despite disconnecting in 27.203 ms. Final connection probes were false in both.
This isolates reproduction from application code but does not establish the
underlying browser/tool cause or prove timely graceful process shutdown. No
deadline was increased, failure ignored, browser reinstalled or unrelated process
terminated. This remains OPEN and neither Edge run is labelled PASS.

The 42 groups exercise the existing built GET server function and current
middleware, not every framework API, a successful POST server function, all
browsers, screen-reader speech, real account integrations or production service.
The previous native EOF/ERR_ABORTED investigation is separate and remains OPEN.
The current audit result cannot promise future vulnerability absence.

Rust/WASM and the vault/landing application code are unchanged relative to the
reviewed PR34 tree; their fresh successful PR34 CI is distinct from the new PR35
CI that must run after publication. Old failing PR35 runs are not overwritten or
presented as new results. No real credentials, deployment, DB/OAuth/payment
activation, branch deletion or force push is part of this checkpoint.
