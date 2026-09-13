# KeyAtlas client bridge

This crate is the platform-neutral Rust boundary shared by future WebAssembly
and Android bindings. It turns authenticated encrypted record heads into an
owned catalog. The client view does not expose a password, API key, token,
recovery code, record envelope, stable record/revision identifier, account
identifier, note, URL, or connection name. The Rust snapshot retains opaque
record identities internally for future in-process actions. Each visible row
receives only a snapshot-local numeric reference; it is invalid after the
snapshot is dropped and must never be treated as authorization.

Catalog names are still private metadata. A snapshot may be used only by an
unlocked local UI. It is not approved for logs, analytics, AI prompts, network
transfer, or real credentials.

The crate deliberately does not depend on `wasm-bindgen`, JNI, or UniFFI yet.
Those thin platform adapters must preserve this allowlist and receive their own
cross-language tests before they are enabled.
