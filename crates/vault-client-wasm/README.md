# Rust WASM catalog boundary (synthetic alpha)

This crate compiles the private, local catalog view into a browser-loadable
WebAssembly module. It is not a production vault or a backend API server.

`WasmCatalogV1` owns one Rust snapshot. Its getters check the object's lock
state. `lock()` drops that snapshot; `free()` releases the generated handle.
There is no exported secret getter, record ID, revision ID, real-user credential
form, network call, or JavaScript vault constructor.

Four private local issuer getters expose only metadata already inside each
authenticated encrypted item: `issuerAccountIdentifier(reference)`,
`issuerOrganizationOrWorkspace(reference)`, `issuerProject(reference)`, and
`issuerEnvironment(reference)`. They return `string | undefined`; absence is
`undefined` (not `null`), and an explicitly stored empty string is preserved.
Each source field is limited to 256 UTF-8 bytes. All four use the same locked and
invalid-reference checks as other row getters. They expose no shared entity IDs,
Console URL, notes, configuration bindings, or secret values.

The `synthetic-demo` feature adds `syntheticCatalog()`, `createSyntheticArchive()`,
`openSyntheticArchive(bytes)`, `appendSyntheticRegistration(bytes, profileId,
credentialId, connectionIds)` and `editSyntheticConnections(bytes, reference,
connectionIds)`. They use fixed synthetic fixtures, real Rust encryption and
authenticated projection. The default build excludes all five.
The bounded archive parser accepts encrypted bytes, but cannot prove synthetic
origin. The public fixed demo password provides no real-secret confidentiality;
there is no real-user initialization/unlock flow.

Creation retains the exact-three-record v1 frame. Append authenticates every
existing record, rejects duplicate identities, preserves the old password and
record ciphertext bytes, and returns a v2 frame with 3–128 records (or retains v3
when appending to an existing history). All versions
retain the 512 KiB archive and 65,536-byte envelope caps. Returned bytes do not
mean storage has committed; the caller owns the explicit durable write.

Registration accepts only two compiled profiles (0 Workshop, 1 Cloud Lab), one
fixed synthetic API credential (0), and at most three distinct connection IDs
(0 MCP, 1 CLI, 2 CI), preserving their selected order. The JavaScript connection
argument is a `Float64Array`: numeric values are checked in Rust before u32
conversion, so fractions, NaN, infinities and wrapping values are rejected.
No arbitrary user text, secret, key export or storage write enters this export.

Connection edits append a same-record successor with a new revision and preserve
every old encrypted envelope. The v3 format has 3–128 explicit ordered heads and
at most 512 immutable revisions, within the same total byte cap. Every revision,
including historical non-heads, authenticates before a catalog or candidate is
returned. Parents must precede children for the same record in a single linear
chain; each explicit head must be that record's final leaf. Duplicate revisions,
branches, missing ancestors and non-leaf heads are rejected unchanged. There is
no automatic history compaction; an archive at capacity rejects further writes.

Legacy v1/v2 archives remain readable. Their first connection edit migrates to v3
only when complete ancestry is available; a legacy successor-only archive is not
rewritten as a fabricated root. `reference` is a row position in the **exact input
archive**, not a persistent record ID. The host must capture it with the displayed
view generation and ciphertext, compare current storage, then CAS those exact
bytes. Changed storage is a conflict, never permission to reinterpret the index.

The head table is not a signed manifest. This transport does not prevent complete
archive rollback/replacement, establish origin/completeness, or implement the
native SQLite durable conflict outbox. A CAS loser is unsaved. The internal edit
API is not yet connected to a user-facing edit form.

## Build and check on Windows

Prerequisites: the repository's Rust toolchain with `wasm32-unknown-unknown`,
Node.js, and the official `wasm-bindgen` CLI exactly `0.2.128`. The helper does
not install anything. Use `KEYATLAS_WASM_BINDGEN` or `-BindgenPath` for an explicit
CLI path; otherwise it checks the KeyAtlas local tools directory and PATH.

From the repository root:

```powershell
.\scripts\build-wasm.ps1 -SyntheticDemo
node scripts/test-wasm.mjs --demo
.\scripts\build-wasm.ps1
node scripts/test-wasm.mjs
```

Outputs go to ignored `apps/web/src/generated/vault-wasm-demo/` and
`apps/web/src/generated/vault-wasm/`. They must be regenerated after checkout.
Dependencies must already be cached because the helper uses `--locked --offline`.
Use `-Release` to request optimization; a successful debug build does not prove
the release build works. Do not bypass Windows application-control blocks.

For the dedicated-worker browser check, see
[`apps/web/tests/wasm/README.md`](../../apps/web/tests/wasm/README.md).
The React `/?view=local-vault` route consumes the synthetic-demo build through a
dedicated Worker, persisting archive bytes in IndexedDB. See
[`apps/web/README.md`](../../apps/web/README.md). This is synthetic-only integration,
not an approval to deploy a real-secret vault.

## Security limits

- Item/provider, issuer fields, and connection names are private metadata, not safe AI or telemetry input.
- Rust can release its owned buffers, not revoke JS strings, DOM text, or copies
  retained by callers. The application must clear state and terminate workers.
- Generated bindings expose memory/ownership machinery. WASM is not protection
  from hostile JavaScript already executing inside the application.
- Authenticated individual records do not prove collection completeness or
  freshness. Trusted rollback/completeness checkpoints remain a launch blocker.
- No real secrets until authentication, recovery, durable encrypted storage,
  host isolation, key lifecycle, and independent security review are completed.

Build-tool reference: [official wasm-bindgen CLI documentation](https://wasm-bindgen.github.io/wasm-bindgen/reference/cli.html).
