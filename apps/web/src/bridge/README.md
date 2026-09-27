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

## Synthetic local tool dispatcher

`syntheticToolProtocol.ts` validates decoded JavaScript objects for exactly
`search_catalog`, `filter_catalog`, and `lock_vault`. It is not a JSON parser,
remote MCP endpoint, authentication boundary, or authorization token.
Unknown/extra/inherited/accessor fields are rejected, own scalar fields are
snapshotted once, and errors never include input values or thrown messages.
Queries are bounded to 128 UTF-8 bytes; both result operations default to 500
rows and accept an integer `maxResults` between 0 and 500 inclusive.

```text
local UI command -> validated action -> SyntheticVaultTools
                                      |               |
                         private UI state         fixed receipt
                         local display rows       ok + action OR error + code
```

`SyntheticVaultTools` reuses `searchLocalCatalog` and owns an effect-bound local
view for the current `SyntheticVaultSession` generation. Constructor calls do
not subscribe or read data. Unbound operations are denied. Lock, session changes,
unbind, and a newer request invalidate pending work and remove owned results.
The lock operation never unlocks and does not wait behind search work. React
mounts the panel only for an open generation, clearing its query on lock/reopen.

The `state.entries` property is private local display data, **not** a tool reply.
`executeTool()` returns only `SyntheticToolReceiptV1`: no rows, names, queries,
IDs, counts, or match/no-match flags. A receipt does not grant permission to add
an external transport. Neither this panel nor dispatcher is connected to an AI,
analytics, storage, provider console, clipboard, or the legacy fixture-only
`toAiSafeInventory` mapper. The private-AI-projection approval gate is unchanged.
Do not serialize the controller or its state into any such route.

Object proxies and application callbacks can reenter same-origin code, so the
dispatcher checks the current generation after parsing and before/after result
notifications. This is lifecycle robustness, not isolation against a compromised
JS realm. Lock cannot erase strings or snapshots already retained by a caller.
