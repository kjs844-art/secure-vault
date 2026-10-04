# KA-C06: signup-mail discovery v1

This is the **synthetic local first slice** of KA-C06. It provides a bounded
metadata scan, explicit confirmation, transient review, and a standalone demo.
It does not complete the task's live provider/privacy/security acceptance gates.
`REAL_SECRET_GATE=CLOSED`.

## 2026-10-03 maintainer integration note

The cloud maintainer selectively reused this slice at source
`117a8f151615c181549432de8800a65e902baf8d` on HEAD
`afbc0fbc4dd41669e468d8658965ef8f5f10ee7d`, with uncommitted app-menu/query-view
wiring and synthetic-only copy, Seoul time display and keyboard focus updates.
The policy, scanner/session, limits and fixture remain byte-identical to the source.
The original standalone entry remains available. C04 is also locally reused;
its demo and this panel still have separate transient review state and no shared
evidence store or real provider authority. Local wiring is not remote merge,
actual Gmail, encrypted evidence integration or release completion.

## Boundaries

- Only fixed synthetic services with reserved `.invalid` sender domains are accepted.
- A scan request names services, a finite `[from, to)` time window of at most 90
  days, and a budget of 1–100 metadata headers. It cannot request the whole mailbox.
- The preview is copied and frozen, including its service list and permission
  policy. A session accepts explicit `true` confirmation of its own exact preview
  object once. A different session's or copied preview is rejected.
- No metadata is inspected before confirmation. Confirming a different date range,
  service list, or budget requires a new session and a new preview.
- A header has **exactly** `senderDomain`, `subject`, and `receivedAt`. Subject is
  limited to 512 UTF-8 bytes; the domain must be syntactically valid and end in
  `.invalid`; dates must be safe, finite integral Unix milliseconds.
- Body, body preview, snippets, recipients, full sender addresses, message IDs,
  attachments, links, tokens, arbitrary fields, getters, and prototype fields
  are not permitted. A malformed/over-budget/future-version batch returns no
  partial results. Both request and batch version are exactly `1`.
- Classification runs synchronously on the client. It never calls a mail provider,
  network API, AI, database, localStorage, analytics, or console logger.

## Permission design for subsequent provider work

| Provider | Proposed exact permission | Available in this slice | Search constraint |
|---|---|---|---|
| Fixed synthetic fixture | No OAuth scopes | Yes | Bounded local metadata only |
| Gmail | `https://www.googleapis.com/auth/gmail.metadata` | No | No `q` full-text query; classify selected metadata locally |
| Microsoft Graph, delegated | `Mail.ReadBasic` | No | Request selected header fields; no body/preview/attachment access |
| Other providers / IMAP | Unspecified | No | Reject until a separately reviewed policy exists |

Broad readonly, mailbox modify, send, application-wide, duplicate, extra, and
unknown permissions are rejected by the policy contract. A token's actual grants
must be verified by a future adapter: passing a declared scope string here is
**not** OAuth authorization, token introspection, or proof of effective privilege.
Both live providers always fail with `LIVE_PROVIDER_UNAVAILABLE` even if their
declared metadata permission is accepted by the policy preview function.

Public documentation references for that follow-up review:

- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail message listing and its `q` restriction](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Graph message listing](https://learn.microsoft.com/en-us/graph/api/user-list-messages)
- [Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference)

The cloud network returned HTTP 403 for the documentation and official GitHub
mirrors on 2026-09-30. The permissions are a proposed design based on the documented
API model; current-provider verification and actual grant tests remain **NOT_RUN**.
Do not implement a fallback to a broader scope merely to enable full-text queries.

## Result and confidence

Only exact allowlisted sender-domain matches, within the selected period, can
produce a hint. Welcome, registration-complete, and email-verification subject
phrases are coarse signals. Password resets, security alerts, receipts, unlisted
senders, newsletters from other domains, and out-of-window messages are ignored.

One aggregated hint per selected service contains only:

```text
serviceId       an allowlisted synthetic service ID
serviceName     its fixed display name
sourceKind      mail_hint
confidence      needs_review | confirmed | dismissed
signals         welcome | registration | email_verification
observedOn      latest matching UTC calendar date (YYYY-MM-DD)
```

No original subject, address, raw timestamp, body, provider message ID, URL, or
recipient/account identifier is copied to the result. Nothing is automatically
registered in the vault. All new hints start at `needs_review`: spoofing, forwarded
messages, marketing, abandoned signup, and third-party signup attempts remain
possible. `confirmed` is an explicit user review decision, never provider proof.
Users can dismiss false positives or put a result back into review.

These terms match KA-C04's `mail_hint`/`needs_review` vocabulary. C04 is a separate,
unmerged branch; this slice does not modify its model, shared mounts, or storage.
Future persistence/integration needs a separately reviewed encrypted evidence
contract and approval to accept genuine personal metadata.

## State and lifetime

```text
awaiting_consent -- explicit same-preview confirmation --> ready
ready -- one successful bounded scan --> review
ready -- invalid/future/excessive metadata --> failed (empty results)
any active state -- five-minute expiry or clock failure/rollback --> expired
any state -- cancel / dispose --> cancelled / disposed (empty results)
```

Expiry is fixed at construction and is checked before actions, after scanning,
and on view access. An expired consent cannot be revived by changing the clock.
The panel refreshes the view every second and disposes the session on unmount.
Changing the scope first discards the old session. Repeated scan or confirmation
is rejected. Error messages contain fixed codes rather than input/provider errors.

The session retains only the plan and minimal hints. Cancel, expiry, failure, and
dispose drop its hint references and counters. These operations do **not** claim
secure erasure of JavaScript strings, immediate GC, or deletion of snapshots held
by callers. The fixed public test fixture is part of this synthetic demo's bundle;
it is not a template for retaining real mailbox input.

## Running and integrating the demo

`apps/web/signup-mail-discovery.html` is a separate Vite entry, so other tasks'
App/LocalVaultPanel mounts remain unchanged. The export
`SyntheticSignupMailDiscoveryPanel` is available for later owner-reviewed
integration. An integrated vault must unmount/dispose it on lock and bind any
future source to the exact consent preview before reading metadata.

The separate production build uses the repository's existing Vite configuration:

```sh
cd apps/web
node --input-type=module -e 'import { build } from "vite"; await build({ build: { outDir: "/tmp/keyatlas-ka-c06-demo-dist", rollupOptions: { input: "signup-mail-discovery.html" } } });'
```

The HTML requests same-origin resources only and includes no analytics, external
provider login, real input, or upload field. Its CSP permits external same-origin
CSS in the production build; Vite's development-time inline CSS injection is not
covered by that policy. The shipped demonstration is the production build.

## Checks and remaining gates

Focused tests cover minimal permissions, scope binding, malformed input,
UTF-8/date/budget limits, no input evaluation without consent, result minimization,
no network/storage/log side effects, review correction, single use, expiry,
clock rollback, and lifecycle cleanup. SSR tests inspect the initial consent
boundary; they do not prove interactive browser behavior.

Real mailbox authorization, current-provider review, provider pagination/rate
limits, source authenticity, revocation, device/browser interaction, C04
integration, encrypted evidence storage, and independent privacy/security review
remain outstanding. The shared KA-C06 task checkbox stays open.
