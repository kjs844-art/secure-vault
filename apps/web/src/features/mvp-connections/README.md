# M03 V2 — private synthetic connection references

Status: pure contract and focused tests implemented; full web/WASM verification is
blocked in the current Windows environment. Not mounted in UI, HTTP or a real vault.

## Purpose and provenance

This models **source service -> key reference -> usage target**, including several
targets of the same kind for one key. It builds on the public provider/usage enums
and synthetic-reference concept submitted in
[PR #17](https://github.com/kjs844-art/secure-vault/pull/17) at
`5fecb0f29ce56b2959b5350913247114ded8e8cf` (Mistral Vibe contribution).

The unpublished V1 shape is deliberately not accepted or silently upgraded: it had
free-text notes, caller-declared verification, no observation/source fields and no
distinct destination identity. No consumer of V1 exists in the reviewed M01A base.
This V2 is **not** a change to the encrypted vault protocol, migration or DB schema.
The submitted branch/PR remain unchanged; this is a reviewed integration adaptation.

## Data boundary

| Input | Exact fields / constraints |
|---|---|
| Snapshot | `schema: keyatlas.mvp-connection-snapshot.v2`, positive safe-integer `snapshotRevision`, `services`, `keys`, `targets` |
| Service row | `reference`, allowlisted `providerSlug` |
| Key row | `reference`, `sourceServiceRef`; that service must exist |
| Target row | `reference`, allowlisted `usage` |
| Proposal input | `schema: keyatlas.mvp-connection-input.v2`, matching `snapshotRevision`, `sourceServiceRef`, `keyRef`, `targetRef`, `sourceKind`, `observedAt` |
| Timing | `nowMs` (integer epoch milliseconds, 1970 through year 9999), `maxEvidenceAgeMs` (1 through 90 days) |

Each reference is an integer 0..127 (negative zero rejected); each array/batch has at
most 128 entries. Those are **synthetic fixture bounds, not Free/Pro product limits**.
Per-kind duplicate references and duplicate service/key/target triples are rejected.
Two distinct MCP target refs for the same key are valid. Empty lists remain empty.

Provider/usage are derived from the detached snapshot; input cannot override them.
`sourceKind` is `manual`, `mail` or `import`, an observation category, not proof that
an actual provider/mailbox was contacted. `observedAt` is null or canonical UTC
`YYYY-MM-DDTHH:mm:ss.sssZ`, not future-dated. Invalid dates are not repaired.

No free-text note, label, URL, email, token, key value, password, unknown field,
accessor, hidden property, array hole or symbol field is accepted. Fixed error codes
do not retain unknown exceptions/messages. Reflection can execute Proxy traps; the
contract catches failures and rechecks closure before returning a result. It is
not a sandbox for arbitrary JavaScript or a guarantee of bounded trap execution.

## Caller flow

1. Build a **synthetic** snapshot and call `createMvpConnectionSessionV2(snapshot)`.
   Real benefit service IDs and vault indexes must never be cast directly into it.
2. `propose(input, timing)` or `proposeBatch(inputs, timing)` returns immutable
   candidates only. A batch validates completely before publishing results.
3. Only after an explicit local user choice call `confirm(originalProposal, timing)`.
   Clones, serialized copies and another session's proposals are rejected, even
   when their revision numbers match. Confirmation is not automatic discovery.
4. Call `close()` on lock, sign-out, identity/snapshot change or teardown. It is
   idempotent and blocks further issuance/confirmation, including synchronous
   close during input inspection. It does not erase already returned metadata.

`freshness` is recent/stale/unknown. Exactly max-age remains recent; one millisecond
older is stale. Missing observation remains unknown, never substituted with now.
`verification` means evidence still requires review: recent -> candidate, otherwise
needs_confirmation. It is **not account ownership or key validity**.

Confirmation adds `userDecision: confirmed`, `confirmedAt` and `proof: not-established`.
It retains original observation/source and re-evaluates evidence. Repeated explicit
confirmations use nondecreasing time and the strictest freshness policy seen for
that proposal; they cannot make stale evidence recent. No persistence/transaction/
global duplicate tracking is implied by a returned confirmation.

## Privacy and future wiring

Even numeric references and relationships are private metadata. Do not automatically
send them to AI/MCP, logs, analytics, URLs, cookies, local storage or another origin.
This module performs no such operations. It does not prove safety of its callers.

The local session/object identity guard is not authentication or a defense against
a compromised page. A future adapter must bind real principal/view scope, snapshot
generation and record revisions, apply authorization/revocation and deletion rules,
and explicitly coordinate lock/close. Existing catalog `consumerType` and these
usage enums differ; do not cast them. Browser/server/DB adapters, cross-origin
transfer, actual account discovery and real secret release remain separate work.

DB/domain/hosting/deployment remain held. Original Lovable/benefit-validator/DB are
unchanged. `REAL_SECRET_GATE=CLOSED`.

## Verification

From `apps/web`: `npm test -- src/features/mvp-connections/mvpConnectionReference.test.ts`
passes 211 focused tests. The full test run still fails loading seven existing WASM
suites because the generated module is missing; 1,653 loaded tests pass. The explicit
non-WASM run passes 43 files / 1,653 tests, not the whole app.

[Exact checks and limits](../../../../../docs/verification/mvp-integration/2026-09-28-m03-connections-v2.md)
record Windows Application Control blocking the Rust/WASM tools and GitHub CI's
account billing/limit blocker. No guard, policy, test configuration or workflow was
weakened to turn those failures into a pass.
