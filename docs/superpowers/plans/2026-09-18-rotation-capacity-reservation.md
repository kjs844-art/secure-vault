# Synthetic rotation completion capacity

Status: bounded implementation and local verification checkpoint complete;
exact-commit remote CI and browser verification remain separate follow-ups.
Baseline `c0dedd4`, follow-up branch `codex/firstvibe-rotation-capacity`.
`REAL_SECRET_GATE=CLOSED`. The existing staging CI is left running rather than
being cancelled by a new push to its concurrency group.

## Problem and scope

Append-only encrypted progress shares the archive's 512 revision / 512 KiB
budget. Repeated intermediate saves can otherwise use the space required to
save ready progress and finalize it. Preserve every existing ciphertext; do not
prune, overwrite, compact, change quotas, or introduce plaintext sidecars.

This guarantees an archive-budget path for newly accepted progress, not physical
disk space, IndexedDB quota, conflict-outbox capacity, provider availability,
rollback protection, or successful future authentication/storage.

## Candidate invariant

Calculate reservations on the fully authenticated **output candidate**, not the
input. For each current canonical head, reserve only its latest active stage:

| Latest active stage | Additional revisions | Additional bytes |
| --- | ---: | --- |
| None | 0 | 0 |
| Pending | 2 | ready stage envelope + 8, final envelope + 4 |
| Ready | 1 | exact selected final envelope + 4 |

Canonical finalization replaces an existing head index: no additional head-map
entry is needed. Use checked arithmetic for actual usage plus all reservations.
Pending-to-ready consumes one revision and releases one reservation;
ready-to-final consumes the final reservation. Unrelated append/edit/cutover
operations must preserve reservations of other active heads. Advancing a head
makes its old stages inactive and releases only that head's reservation.

Existing v4 archives without sufficient reserved space remain readable and
backuppable. Apply the new invariant at new-revision mutation boundaries only,
not in parser/authentication/restore/read validators. Rejected candidate writes
leave the original and all stages unchanged. Ready-to-pending edits may need
more reserved space and can be rejected.

## Size authority

Core authenticates the base and stage pair, applies the same closed transforms
as real synthetic stage/final generation, canonically encodes into zeroizing
buffers, and uses the existing padding selector. Crypto owns the pure envelope
length calculation alongside its serializer; do not duplicate fixed overhead
in core. Do not draw RNG or generate throwaway ciphertext to estimate space.

For pending stages, the maximum ready form completes all non-Removed fixtures
and confirms revocation. Compare that bound with actual outputs for all valid
closed completion choices; cover padding boundaries, history, and generations.
For ready stages, use the exact saved choice's final size.

## Ownership and verification

- Core/crypto agent: pure sizing API, bounded opaque projection, sizing tests.
- Archive agent: all mutation boundaries, checked budgets, policy/integration tests.
- Main: user-facing limits explanation, web regression, documentation, integration.
- Independent review after implementation; preserve default/synthetic feature
  isolation, source secret scan, formatting, targeted tests, release WASM smoke,
  web typecheck/build/tests. Keep local AppControl blocks distinct from failures
  and from exact-commit remote CI evidence; do not weaken OS policy.
- Explicit-file commit and non-force feature-branch push after relevant checks.
  No main merge, real secrets, provider calls, or public deployment.

## Required evidence

1. Budget equality accepted and one-over rejected for count and bytes.
2. Pending save followed by ready save and finalization at the budget boundary.
3. Multi-head aggregation; unrelated mutation cannot consume reserved space.
4. Own-head advancement releases its reservation; others remain protected.
5. Historical over-budget-reservation v4 still opens and rejected mutation
   preserves input bytes. Old stages remain encrypted and immutable.
6. Actual sealed stage/final sizes stay within the pure sizing projection,
   including generation 2 and a padding-bucket crossing.
7. Web limit rejection causes no storage write or implicit retry; existing
   snapshot remains available and the user receives bounded guidance.
