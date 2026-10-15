# Durable synthetic rotation: saved progress through final cutover

Base: `bbbe899d4e8750f7aaefb4faf30693b97efb0567`.
Branch: `codex/firstvibe-rotation-staging`.
`REAL_SECRET_GATE=CLOSED`.

## User-visible completion criterion

Start a synthetic key replacement, save some connection confirmations, lock or
reload, reopen and authenticate the saved progress, confirm the remaining work,
then explicitly commit the replacement. The original canonical credential stays
current until that final cutover. This plan is not complete at a codec, mock, or
single native API checkpoint: it includes the Worker/session/UI and restore path.

The existing requirement in
[the credential core plan](2026-08-14-synthetic-credential-local-core.md#follow-up-plan-boundaries)
requires intermediate encrypted candidates to be siblings of the same canonical
head. It rules out treating every progress save as a new canonical revision.

## Representation and compatibility

- Keep the credential payload schema and encrypted envelope at v1. Existing
  `Rotating`, pending revocation, connection evidence and partial rotation sets
  represent the candidate; completed events retain their existing meaning.
- Introduce synthetic archive framing v4. Preserve the v3 canonical revision
  sequence and head map and add a separate ordered list of staged entries.
  Each entry carries a canonical base index and one existing encrypted credential
  envelope. The encrypted parent/record relationship must authenticate that index.
- Wire layout: magic, version, head count, canonical revision count, stage count
  (all counts little-endian u32); length-prefixed password envelope; canonical
  envelopes; head indexes; then `(base index, length-prefixed stage envelope)`.
  Do not serialize plaintext selection/evidence, Secret values or account metadata
  into the framing, IndexedDB side keys, logs, or browser storage.
- Keep the 512 KiB archive and existing envelope/head bounds. Canonical plus
  staged revisions together must not exceed 512. Validate counts/lengths and every
  envelope shape before KDF work. Authenticate all canonical and staged records,
  including inactive stages, before exposing catalog or progress.
- Preserve v1/v2/v3 reads. The first progress save promotes an authenticated
  genesis/history archive to v4 without changing any original envelope. Unknown
  later versions fail closed and remain in storage.
- Stages are append-only snapshots and are never inserted into canonical history.
  Among stages for the current head, the last framing entry is the selected saved
  progress. This is local selection, not a signed latest-state or rollback claim.
- Append/edit/one-step rotation must preserve v4 stages and must not downgrade the
  archive. When a canonical head advances, its old stages become inactive and stay
  byte-for-byte in the archive. Do not automatically rebase or apply them.
- Backup/restore carries the same complete v4 archive. Keep the existing conflict
  outbox guard, bounded storage and atomic snapshot checks.

## Core boundary

An opaque `SyntheticRotationStageV1` exposes only its ciphertext envelope, without
the ordinary canonical commit projection. Construction accepts only closed
fixture completion choices and pending/user/provider-simulated revocation enums.
All candidate snapshots for H use H as their parent, including when H itself
contains a completed event from an earlier rotation.

Inspection authenticates both H and the candidate, checks record/parent identity,
the exact next built-in generation, evidence consistency, and preservation of all
fields outside the allowed rotation changes. It returns fixed enums and counts
only. Finalization consumes an authenticated saved stage and requires completed
required connections plus explicit revocation evidence. The final active successor
also has H as parent; immutable completed-event history remains unchanged.

## Web boundary

- New demo-only WASM exports save a staged candidate archive, inspect current
  saved progress, and create final cutover from the saved stage. Default builds
  continue to expose no synthetic operations.
- WASM inputs remain strict primitive/closed selections. Saved projections are
  getter-only, lockable and disposable. The adapter and Worker client validate
  the exact output shape and state invariants before React receives them.
- Session operations bind reference, displayed bytes and generation. Use the
  existing ciphertext CAS/outbox behavior; candidate authentication, exact
  readback and reauthentication precede success. Late results after locking must
  neither reopen a session nor restore old user consent.
- UI supports explicit save-progress, restore-progress and final review/confirm.
  Restored progress never restores the final confirmation checkbox. A saved
  partial stage is not shown as a completed key replacement.

## Required evidence

1. Native sibling snapshots keep H unchanged; final F alone advances the canonical
   credential. Existing generic-edit and completed-history rejections remain.
2. Authentication rejects a different record, parent, generation, duplicate
   revision, missing/unknown connection, or modification outside allowed fields.
3. v1/v2/v3 → v4 preserves all existing bytes; later append/edit/cutover preserves
   stages; bounds, trailing data and future versions reject without replacing data.
4. Actual WASM plus storage: partial save → discard session/Worker → reopen →
   authenticate restored progress → finish. Browser Worker/IndexedDB evidence is
   recorded separately from fake IndexedDB evidence.
5. CAS competition, lock/cancel, post-CAS displacement and backup/restore cover
   staged archives. Never silently retry, merge, overwrite, or evict a candidate.
6. Focused tests, type checking/build, applicable native format/Clippy, repository
   Secret scan and independent review. Review the changed synthetic archive
   baseline before updating the scanner's exact source hash.

## Current evidence and remaining work

- Predecessor UI checkpoint is committed and pushed. GitHub remote SHA was verified
  as `bbbe899d4e8750f7aaefb4faf30693b97efb0567` on 2026-09-18.
- Its [CI run](https://github.com/kjs844-art/secure-vault/actions/runs/35242399539)
  passed the repository scan, both PowerShell scanner regressions and workflow
  policy check at the observed checkpoint; full Rust verification was still running.
- The durable workflow is implemented through UI and backup/restore. Actual
  browser Worker/WASM/IndexedDB save/reload/resume/finalize and generated-WASM
  integration passed; final web suite is 41 files / 1,346 tests. This is not a
  full QA/release pass: local App Control blocks broad Rust Clippy/test commands,
  and PowerShell 5.1 execution policy blocks its scanner regression invocation.
  See [exact evidence and limits](../../verification/2026-09-18-durable-synthetic-rotation.md).
- Full archives refuse all writes without deleting records. Reserved finalization
  capacity and retention policy remain a follow-up before real-user durability.
- Domains, provider accounts, billing, real Secret input, recovery approval,
  deployment and final design choices remain outside this implementation.
