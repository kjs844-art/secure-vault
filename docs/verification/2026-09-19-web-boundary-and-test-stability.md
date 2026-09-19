# Web Boundary and Test Stability Checkpoint

## Scope

This checkpoint hardens the synthetic web/WASM boundary and removes a
nondeterministic large-byte test bottleneck. It does not enable real passwords,
API keys, tokens, external providers, or production deployment.

`REAL_SECRET_GATE=CLOSED` remains unchanged.

## Fail-closed WASM lock state

`WasmCatalogAdapter` previously used JavaScript truthiness for both
`isLocked()` checks. A malformed or version-skewed runtime value such as
`undefined`, `null`, `0`, an empty string, or `NaN` could therefore be treated
as unlocked.

Both reads now require an actual boolean. Only `false` proceeds, `true` remains
`LOCKED`, and every nonboolean becomes `INVALID_CATALOG`. Regression cases
exercise falsey and truthy nonbooleans before row projection and after row
projection. They also prove that no rows are published and that cleanup calls
both `lock()` and `free()` exactly once.

A generation check now also follows the final foreign `isLocked()` call. This
prevents a reentrant handle from calling adapter `lock()` or `dispose()`,
returning `false`, and then causing a stale handle and rows to be published.

The adapter continues to copy only its explicit metadata allowlist. This change
does not make raw Secret fields available to JavaScript.

## Exact-byte test stabilization

The full web suite intermittently exceeded Vitest's default five-second limit
while comparing 524,289-byte corrupt IndexedDB values. The product rejected the
oversized value correctly; the slow part was Vitest enumerating more than half
a million typed-array properties during `toEqual`.

The affected preservation assertions now keep the same strength while using a
test-only comparator that verifies:

- the exact key list and value count;
- the exact `Uint8Array` prototype and byte length;
- every visible byte, restricted by `byteOffset` and `byteLength`, through
  `Buffer.equals`;
- ordinary deep equality for non-byte values.

No product storage code, 512 KiB limit, corruption policy, or global test
timeout changed.

## Verification

All inputs were synthetic.

- `WasmCatalogAdapter.test.ts`: 82/82 passed.
- `SyntheticCiphertextStore.test.ts`: 122/122 passed, then repeated five times
  with 122/122 on every run.
- Full web suite with normal worker settings: 46 files, 1,467/1,467 tests
  passed.
- Full web suite with `--maxWorkers=1`: 46 files, 1,467/1,467 tests passed.
- TypeScript typecheck: exit `0`.
- Production web build: exit `0`, including the synthetic WASM bundle.
- Repository Secret scan after the build: exit `0`, `SECRET_SCAN_PASSED`,
  `REAL_SECRET_GATE=CLOSED`.

## Limits

- These are Node, Vitest, `fake-indexeddb`, and synthetic WASM checks. They do
  not prove behavior in a real browser profile or with real Secret material.
- The branch inherits the documented GitHub Actions account billing/spending
  block, so a complete remote workflow has not run for this checkpoint.
