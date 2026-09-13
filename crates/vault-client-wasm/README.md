# Rust WASM catalog boundary (synthetic alpha)

This crate compiles the private, local catalog view into a browser-loadable
WebAssembly module. It is not a production vault or a backend API server.

`WasmCatalogV1` owns one Rust snapshot. Its getters check the object's lock
state. `lock()` drops that snapshot; `free()` releases the generated handle.
There is no exported secret getter, record ID, revision ID, real-user credential
form, network call, or JavaScript vault constructor.

The `synthetic-demo` feature adds `syntheticCatalog()`, `createSyntheticArchive()`
and `openSyntheticArchive(bytes)`. They use fixed synthetic fixtures, real Rust
encryption and authenticated projection. The default build excludes all three.
The bounded archive parser accepts encrypted bytes, but cannot prove synthetic
origin. The public fixed demo password provides no real-secret confidentiality;
there is no real-user initialization/unlock flow.

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

- Item/provider and connection names are private metadata, not safe AI or telemetry input.
- Rust can release its owned buffers, not revoke JS strings, DOM text, or copies
  retained by callers. The application must clear state and terminate workers.
- Generated bindings expose memory/ownership machinery. WASM is not protection
  from hostile JavaScript already executing inside the application.
- Authenticated individual records do not prove collection completeness or
  freshness. Trusted rollback/completeness checkpoints remain a launch blocker.
- No real secrets until authentication, recovery, durable encrypted storage,
  host isolation, key lifecycle, and independent security review are completed.

Build-tool reference: [official wasm-bindgen CLI documentation](https://wasm-bindgen.github.io/wasm-bindgen/reference/cli.html).
