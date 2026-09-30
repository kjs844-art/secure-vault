# Selected source and dependency provenance

Source: user-owned [benefit-validator](https://github.com/kjs844-art/benefit-validator)
at commit `954da8da0b12d55a342d187fab17abe57b93fbb0`.
Destination: KeyAtlas secure-vault / apps/benefits-web, M01A integration branch.
Source was read through fixed Git blobs; original app, main branch, environment and DB
were not modified. No .env file or real mail/key/DB content was read or imported.

| Source | Destination/use | Adaptation |
|---|---|---|
| src/router.tsx | src/router.tsx | Per-request QueryClient, route tree generation retained |
| src/routes/__root.tsx | src/routes/__root.tsx | Korean document/SSR shell retained; vendor telemetry, fonts, live UI hooks removed |
| src/start.ts | src/start.ts | Explicit framework CSRF middleware retained; donor auth/error hooks not imported |
| src/lib/benefits.ts | src/domain/benefits.ts | Types/labels/invariants retained; invalid inputs/calendar edge cases tested |
| src/lib/export-format.ts | src/domain/export-format.ts | Existing format identifier retained; not an export implementation |
| package.json + bun.lock | Independent package.json/package-lock.json | Exact direct runtime/tool versions from source; public npm registry lock regenerated |
| vite.config.ts + src/server.ts | New explicit config/server boundary | No Lovable config, MCP plugin, install patch, error capture or provider integration |
| src/lib/gmail.functions.ts | New src/server/mail pure contracts/parser/validator | Retains separate grant/balance/day concepts; replaces unbounded parsing, current-date fallback and immediate upsert with bounded ephemeral pending candidates |

The index page is a technical migration placeholder, **not** a replacement design
or a claim that the original UI was fully ported. The M02 contribution in secure-vault
PR #21 at `e19ae37872a1cb2324d4c227593fbf57f8731667` supplies eight components under
`src/components/mvp-demo/` and the synthetic `src/lib/mvp-demo-data.ts` dataset.
Those nine files were selectively imported into M01A, not merged with the whole branch.
M01A adds the `/demo` route, strict-type fixes, one SSR/client reference-time seed,
honest expiry/unknown values, counts instead of unlike-benefit totals, and actual
focus/scroll navigation. The contribution's inline layout is retained; no design
framework, live provider, new dependency, original environment or DB is imported.

The source tree has no LICENSE/NOTICE/COPYING file. Public repository visibility is
not a grant of a new license; this work does not relicense it. Review third-party
code/assets and dependency licenses before public distribution. Dependency code is
not vendored and its own license/notice terms remain applicable.

Exact direct versions were taken from source bun.lock, not the wider caret ranges.
The donor lock contains vendor registry URLs and is not copied. New installation
uses npm's public registry with lifecycle scripts disabled; package-lock integrity
and registry URLs are checked by `npm run check:boundaries`.
That check does not establish that every transitive package is vulnerability-free.

Framework references consulted 2026-09-27:

- [TanStack server entry](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point)
- [TanStack Nitro/Node hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting)

Gmail representation references consulted 2026-09-28:

- [Message and FULL parsed payload](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
- [MessagePartBody base64url data](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments)

The new parser targets the API's already-parsed part representation, not raw MIME.
It decodes the outer base64url once; original transfer-encoding headers do not
trigger another decoding pass. No real Gmail response or account was accessed.
