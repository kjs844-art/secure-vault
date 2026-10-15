# Generated WASM browser smoke test

This test uses only the feature-gated synthetic-demo WASM package. Build that
package at `src/generated/vault-wasm-demo/vault_client_wasm.js` first, then serve
the existing `apps/web` Vite development server and visit:

```text
http://127.0.0.1:<vite-port>/tests/wasm/
```

It is a test page, not production UI. Direct `file://` loading and static servers
without TypeScript module transformation are not supported. No secret input,
external API, persistence, or credential discovery is part of this harness.

All WASM initialization and synthetic cryptography run in a dedicated Web Worker.
The worker imports the generated module directly and lets its default `init()`
resolve the neighboring `.wasm` file. It checks:

- The generated catalog has three entries.
- Locking the catalog makes `length()` throw the fixed `LOCKED` code.
- Generated handles work through the TypeScript allowlist adapter.
- Lock clears adapter-owned row references.
- A handle arriving after lock is rejected as a stale asynchronous result.

The worker sends only fixed pass/fail JSON; no names, rows, keys, raw errors,
stack traces, or WASM handles cross back to the page. The page terminates the
worker after a result, startup error, or 60-second timeout. Its only output is a
fixed result code, also reflected in `document.documentElement.dataset.smokeStatus`.
Passing does not establish production unlock, browser-storage integration,
zeroization of JS copies, or security of future UI code.

Expected result:

```json
{"schemaVersion":1,"status":"pass","code":"WASM_SMOKE_PASSED"}
```

Syntax-only checks (these do not execute generated WASM):

```powershell
node --check tests/wasm/worker.js
node --check tests/wasm/smoke.js
```
