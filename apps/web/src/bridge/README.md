# Local WASM catalog adapter

`catalogProtocol.ts` matches the scalar methods of generated `WasmCatalogV1`.
`WasmCatalogAdapter` owns a fresh handle from an injected factory. The current
factories are feature-gated `syntheticCatalog()` and `openSyntheticArchive(bytes)`
in the local-vault Worker. This is not a real-user vault unlock flow or a
connection from browser storage to SQLite.

```text
Rust catalog -> reviewed getters -> local UI metadata rows
                                      |
                                lock / dispose
                                      |
                      clear owned rows + lock/free handle
```

Rows contain temporary references, item/provider names, kind, status, and three
counts, plus bounded connection labels and allowlisted consumer types. They
exclude secret values, persistent IDs, notes, account identifiers, URLs, and MCP
configurations. Item/provider and connection names remain private metadata: do
not log, persist, export, or send plaintext rows to AI or analytics.

Each factory invocation must transfer exclusive ownership of a fresh handle.
Await/catch `load()` and handle its fixed `CatalogAdapterError` code. Newer loads,
lock, and disposal reject stale completions with `CANCELLED`; partial rows are
never published. `dispose()` is permanent; `lock()` permits a later explicit load.

Lock clears adapter-owned row references and locks/frees Rust. It cannot securely
erase JavaScript strings, caller-held arrays, React state, browser memory, or
developer-tool snapshots. The local-vault UI clears its own state and DOM on lock.
Rust zeroization does not cover JS string copies. If cleanup throws, owned
references still clear, free is attempted, and `CLEANUP_FAILED` is returned.

No network, storage, generated module import, UI, or lifecycle event registration
is added to this adapter module. Real generated-WASM runtime tests and caller
lock/unmount wiring live in `tests/wasm` and `features/local-vault`. Adapter
contract tests still use injected synthetic handles.

From `apps/web`:

```powershell
npm test -- src/bridge/WasmCatalogAdapter.test.ts
npm run typecheck
```
