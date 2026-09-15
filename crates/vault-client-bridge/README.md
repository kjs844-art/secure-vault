# KeyAtlas client bridge

This crate is the platform-neutral Rust boundary shared by future WebAssembly
and Android bindings. It turns authenticated encrypted record heads into an
owned catalog. The client view does not expose a password, API key, token,
recovery code, record envelope, stable record/revision identifier, shared
account/project entity reference, note, URL, or configuration binding. The Rust snapshot retains opaque
record identities internally for future in-process actions. Each visible row
receives only a snapshot-local numeric reference; it is invalid after the
snapshot is dropped and must never be treated as authorization.

The allowlist includes item/provider labels, credential kind/status, selected
counts, connection labels/types, and exactly four optional issuer display fields:
`issuer_account_identifier`, `issuer_organization_or_workspace`, `issuer_project`,
and `issuer_environment`. Each issuer field is at most 256 UTF-8 bytes. `None`
means absent; an explicitly stored empty string stays `Some("")`. No values are
inferred from provider or item labels. Core projection moves their owned strings
from the authenticated item and zeroizes them on drop like other local metadata.

Catalog names and issuer fields are still private metadata. A snapshot may be used only by an
unlocked local UI. It is not approved for logs, analytics, AI prompts, network
transfer, or real credentials.

The crate deliberately does not depend on `wasm-bindgen`, JNI, or UniFFI yet.
Those thin platform adapters must preserve this allowlist and receive their own
cross-language tests before they are enabled.

Compile-fail checks retain the secret/identifier/serialization boundary and
explicitly reject notes, Console URL, and shared account/project reference getters.
The issuer projection is not an expansion of an AI or network-facing inventory.
