# Synthetic rotation lifecycle and authenticated history checkpoint

Date: 2026-09-17. Branch: `codex/firstvibe-rotation-history-lifecycle`.
Base commit: `2b0890f30a0a4a8ec0ca2eaed35b205901c8ff28`.

This is a synthetic-only implementation checkpoint. It does not
approve release or real credentials. `REAL_SECRET_GATE=CLOSED`.

## What changed

- A rotation event belongs to the immutable cutover revision that recorded it.
  Creating a successor does not modify that stored envelope.
- Before a generic or connection-edit successor may continue, the authenticated
  predecessor event must be complete: the item is active, the event names the
  immediate parent, required/completed/current-required connection sets match,
  the primary Secret is the expected post-cutover generation, current and
  superseded revocation tuples and all recorded times match that generation, and
  every non-removed connection is either freshly verified or explicitly marked
  update-required. Metadata alone cannot turn generation `0001` into completion.
- A valid completed event is cleared only from the newly owned successor payload.
  Decoder-valid legacy incomplete events remain readable but fail before the edit
  callback or revision RNG. They cannot be silently erased by a no-op, connection
  edit or later cutover.
- The closed synthetic sequence supports `0001 -> 0002 -> 0003`, including general
  and connection edits between the two cutovers. `0003` is terminal for another
  synthetic cutover but remains ordinarily editable. These fixed values and times
  are fixtures, not provider evidence.
- A read-only history API authenticates the caller-supplied head and every supplied
  ancestor, then requires one exact same-record/session/epoch parent chain. Missing
  parents, duplicates, cycles, unrelated records and unused branches fail closed.
- The authenticated chain must start at `0001`. A revision without a cutover event
  must preserve its parent's generation; a locally complete event is reported as
  complete only for the consecutive `0001 -> 0002` or `0002 -> 0003` transition.
  Decoder-valid incomplete or discontinuous legacy events remain readable as
  `Incomplete` and cannot authorize mutation.
- History input is bounded to 512 revisions and 8 MiB aggregate ciphertext before
  authentication. Returned events are newest first and expose only opaque revision
  and parent IDs, bounded connection counts, completion state and recorded
  revocation-source enum. No Secret, notes or arbitrary display text are returned.

## Code map

| File | Responsibility |
|---|---|
| `crates/vault-local-core/src/rotation_lifecycle.rs` | Mutation-only completed-event guard and successor-local event clearing |
| `crates/vault-local-core/src/persistence.rs` | Applies the lifecycle guard before mutation and revision entropy |
| `crates/vault-local-core/src/connection_edit.rs` | Separates pure closed-profile identification from mutation-only lifecycle policy |
| `crates/vault-local-core/src/rotation.rs` | Resets prior completion before evaluating the next closed synthetic cutover and selects the next fixture generation |
| `crates/vault-local-core/src/rotation_history.rs` | Bounded, fully authenticated parent-chain inspection and sanitized event projection |
| `crates/vault-local-core/src/rotation_lifecycle_tests.rs` | Repeat rotation, edits, legacy incomplete fail-closed, immutability and RNG-order tests |
| `crates/vault-local-core/src/rotation_history_tests.rs` | Chain integrity, limits, public projection and supplied-head authority tests |
| `crates/vault-local-store-sqlite/tests/commit_cas.rs` | Restarted SQLite chain/CAS preservation across rotations and edits |

The decoder and stored wire format are unchanged.

## Security boundaries

- The history query authenticates only the chain supplied by the caller. It does not
  prove that this head is the canonical latest head and is not a rollback or omitted-
  row anchor.
- `User` and `ProviderConnector` are recorded enum values from synthetic fixtures.
  No provider was contacted and no external update or revocation was verified.
- This checkpoint has no durable intermediate rotation checklist, optional-connection
  confirmation API, retry/resume state, reminders or real credential generation.
- It has no web, Worker, WASM, browser, Android, biometric, recovery or sync wiring.
- It does not alter, delete or repair stored history. All tests use synthetic data.

## Verification evidence

| Check | Result |
|---|---|
| `cargo test --locked --offline -p vault-local-core --lib rotation -- --test-threads=1` | exit 0, 38 passed, 0 failed, including public two-cutover history, fabricated completion, optional-state and generation-continuity regressions |
| `cargo test --locked --offline -p vault-local-store-sqlite --test commit_cas completed_rotations_allow_edits_and_preserve_the_full_chain_after_restart -- --test-threads=1` | exit 0, 1 passed, 0 failed |
| `cargo fmt --all -- --check` | exit 0 |
| `cargo clippy --locked --offline -p vault-local-core -p vault-local-store-sqlite --all-targets --all-features -- -D warnings` | exit 0 |
| `scripts/check-repository-secrets.ps1` | exit 0, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED` |
| `git diff --check` | exit 0 |
| Final independent lifecycle/history security review | Critical 0, Important 0 after three review/fix cycles |

Still pending for this checkpoint:

- a committed SHA and whole-workspace/remote CI for that SHA

The first post-fork attempt to launch a newly linked unsigned test executable was
temporarily blocked by Smart App Control (`4551`). No Windows security control was
changed or bypassed. After the normal policy evaluation settled, the same build and
the final focused/full tests executed successfully as recorded above.

The local whole-workspace verifier later reached workspace Clippy but Smart App
Control blocked newly compiled unsigned proc-macro DLLs (`thiserror_impl` and
`rustversion`), reported by Rust as `E0463`. The scoped current-package Clippy and
all focused executable tests above remain successful; the whole-workspace result
must therefore come from the unchanged remote security workflow.

## Residual work

After the final tests and regression gates, the next product-aligned work remains a
durable encrypted checklist/resume model, explicit optional-connection verification,
web/WASM/session integration and independently reviewed recovery/sync/latest-head
anchors. This checkpoint is not the completed MVP and does not open real input.
