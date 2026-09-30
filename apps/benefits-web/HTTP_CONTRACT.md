# Catalog HTTP boundary — synthetic, not connected

2026-09-28. `REAL_SECRET_GATE=CLOSED`.

`src/server/http/catalog-http.ts` exports a provider-independent Fetch handler.
It composes the [catalog controller](CATALOG_CONTRACT.md) with injected session,
admission and transaction ports. **The running SSR app does not mount it.**
`/api/catalog` and its children still return 503 `INTEGRATION_NOT_CONNECTED`.
There is no real cookie issuer, authentication service, shared limiter or DB here.

## Request and result contract

All actions use POST, including reads, so private IDs/cursors do not go in URLs:

| Exact path | Catalog action / body |
|---|---|
| `/api/catalog/create` | `create`: operationId, decision, profile |
| `/api/catalog/update` | `update`: serviceId, expectedRevision, operationId, decision, profile |
| `/api/catalog/delete` | `remove`: serviceId, expectedRevision, operationId, decision |
| `/api/catalog/get` | `get`: serviceId |
| `/api/catalog/list` | `list`: limit, cursor |

The exact field schemas and semantic limits are in the catalog contract and decoder.
Owner/session authority is NEVER accepted from these JSON commands.

- Operator-configured exact trusted origin: HTTPS, or HTTP loopback only.
  Do not derive it from request Host/Forwarded/body values.
- Exact matching request origin and Origin header; `X-KeyAtlas-Request: catalog-v1`.
  Sec-Fetch-Site, when present, must be `same-origin`. No query/hash/userinfo.
- A nonempty, bounded ASCII cookie context goes only to the trusted session port.
  Authorization headers are rejected; this is not a public bearer-token API.
- Content-Type is application/json with optional charset=utf-8. No compression.
  Read at most 16,384 actual bytes before decoding; declared length must match.
- Strict UTF-8, object root, duplicate decoded keys/BOM/trailing input rejected.
  JSON permits at most 12 container levels and 256 values including containers.
  The reader is not a substitute for catalog field validation.
- The whole request has a maximum 10-second deadline, tightened by session/permit.
  It applies across async ports and body reads, not 10 seconds per adapter call.
- Success is `{ ok: true, value }`, where value is CatalogReceipt, CatalogView or
  CatalogPage. Profile values remain user-reported, not proof of a real account.
  Serialization has a 1 MiB output check plus a final authority/deadline check.

Responses use fixed errors, JSON, private/no-store, nosniff, no-referrer,
frame denial and a restrictive response CSP. They never echo adapter errors,
cookies, raw bodies or cancellation reasons, and never set cookies or CORS headers.

| Code group | Status |
|---|---|
| API_NOT_FOUND | 404 |
| API_METHOD_NOT_ALLOWED | 405, Allow: POST |
| API_REQUEST_REJECTED / API_SESSION_CHANGED | 403 |
| API_AUTH_REQUIRED | 401 |
| API_MEDIA_TYPE / API_BODY_TOO_LARGE / API_INPUT_INVALID | 415 / 413 / 400 |
| API_RATE_LIMITED | 429, bounded Retry-After: 1..60 seconds |
| API_CONFLICT | 409 |
| API_TIMEOUT / API_ABORTED | 408 |
| API_UNAVAILABLE | 503 |

## Authority, admission and writes

The first verified owner/session/revision/generation/expiry is captured once.
Every later session read must still match it: a request begun for A cannot finish
as B after an account switch. Revoked/expired/changed sessions fail closed.

The admission port must atomically enforce shared attempt limits. Its exact-key
permit is bound to request ID, action, initial authority and a bounded expiry.
Malformed or unavailable admission fails closed; reusing an operation ID does not
bypass request admission. The synthetic fixture is NOT a production limiter.
Unauthenticated/IP limits, upstream connection/header limits and proxy trust remain
separate deployment work. Origin checks alone are not authentication.

The transaction port must enforce actual authority, commit deadline, unique IDs,
revision/CAS and service/benefit references at entry and commit. It must return only
after acknowledgement. A fake memory implementation is used in tests only.

Cancellation and deadlines bound what the handler returns and signal cooperative
ports to stop. **An error or disconnected client is not evidence of rollback.**
An already committed write may survive a late acknowledgement/abort. The caller
must retain the exact original command/operation ID for an explicit same-operation
retry in the same scope; do not silently create a new operation or claim success.
This contract does not yet provide an atomic database cancellation predicate.

`RequestLifetime` checks wall and monotonic deadlines synchronously as well as by
timer, so event-loop delay cannot make a late response valid. Each clock retains
the error reason of its own minimum deadline. Timers/listeners are cleaned up.

## Evidence and remaining integration

See [the checkpoint evidence](../../docs/verification/mvp-integration/2026-09-28-catalog-http.md).
Handler tests use in-memory Fetch Request/Response objects and a synthetic store;
they are not real network framing/proxy, OAuth, RLS, durable DB or browser E2E proof.
The separate SSR loopback smoke confirms that the public route stays disconnected.

Real auth/DB/limiter adapters, browser transport and actual HTTP integration QA
remain follow-ups. Do not enable routes, import test adapters into production,
connect the frozen benefit-validator/Lovable DB, use real secrets, or resume the
user-held DB/domain/hosting/deployment setup as part of this checkpoint.
