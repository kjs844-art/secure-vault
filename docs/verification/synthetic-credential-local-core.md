# Synthetic credential local core verification

`tested_commit`: `aedcff4e27eda16d8af96aee15724be30a875961`

This record covers the synthetic-only credential local-core slice committed
before this document. It is not approval to store real credentials.

## Environment

- Verified at: `2026-08-15T12:48:04+09:00`
- Windows: `Microsoft Windows [Version 10.0.26200.9168]`
- Rust: `rustc 1.95.0 (59807616e 2026-04-14)`
- Cargo: `cargo 1.95.0 (f2d3ce0bd 2026-03-21)`

## Deterministic verification results

Every command below ran from the repository root against `tested_commit`.

| Command | Exit code | Result |
| --- | ---: | --- |
| `cargo metadata --no-deps --format-version 1` | 0 | The workspace resolved exactly two local packages: `vault-crypto` and `vault-local-core`. |
| `cargo fmt --all -- --check` | 0 | No formatting changes were required. |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | 0 | All targets passed with warnings denied. |
| `cargo test --workspace --all-features -- --test-threads=1` | 0 | 68 top-level Rust test-harness tests passed, 0 failed, 0 ignored. The two trybuild harness tests included 24 compile-fail cases (16 `vault-crypto`, 8 `vault-local-core`), all of which passed for their committed diagnostics. Both doc-test harnesses contained 0 tests. |
| `cargo run -p vault-local-core --example synthetic_credential_roundtrip` | 0 | The exact stdout is recorded below. |
| `cargo tree --workspace --all-features` | 0 | The complete dependency tree resolved; no product-runtime database, network-client, UI, clipboard or browser integration dependency is present. The dev-only `trybuild` dependency compiles the negative API-boundary tests. |
| `git diff --check codex/firstvibe-recovery-credential-design..HEAD` | 0 | No whitespace errors were found in the implementation-branch diff. |
| `git rev-parse HEAD` | 0 | Printed `aedcff4e27eda16d8af96aee15724be30a875961`. |

### Bounded credential-pattern scan

The original table rendering escaped each alternation pipe as `\|`. In the
Rust regex syntax used by ripgrep, `\|` matches a literal pipe and is not
equivalent to alternation. This was demonstrated without credential-shaped data:

```powershell
"alpha" | rg --quiet -- 'alpha\|beta' # exit 1
"alpha" | rg --quiet -- 'alpha|beta'  # exit 0
```

The authoritative repository scan was therefore re-run with the required
unescaped alternation operators exactly as follows:

```powershell
rg -n --hidden --glob '!target/**' --glob '!.git/**' -- "(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,})" .
```

The corrected scan exited `1`, printed empty stdout, and found no matches. That
is the expected ripgrep no-match result.

Exact example stdout:

```text
provider=Example AI Workshop
connections=1
mcp_recorded=true
synthetic_only=true
```

`gitleaks` was unavailable on this workstation (`Get-Command gitleaks` found
no executable), so no gitleaks pass is claimed. The bounded `rg` scan above did
run and found no matches.

## Plan-specific security assertions

The full branch diff from `codex/firstvibe-recovery-credential-design` through
`tested_commit`, the public exports in `crates/vault-local-core/src/lib.rs`, the
relevant source files, the compile-fail diagnostics and the dependency tree were
inspected for each assertion.

1. **No public arbitrary-plaintext constructor.** The only public creation entry
   point is `seal_synthetic_fixture_v1`, and its only content selector is the
   closed `SyntheticCredentialFixtureId` enum. `CredentialItemV1`, its builder,
   `SecretValueV1::new`, and the payload codec remain crate-private. There is no
   public free-form create, update, paste or import API.
2. **No caller-provided entropy, nonce, record ID or revision ID.**
   `generate_record_identity` performs one internal `getrandom::fill` into a
   48-byte block and splits it into the 16-byte record ID and 32-byte revision
   ID. Both `from_bytes` constructors are crate-private. The committed trybuild
   cases `caller_record_id.rs` and `caller_revision_id.rs` prove external callers
   cannot invoke them. No nonce or entropy parameter appears in a public local-
   core API.
3. **No `Debug`, `Clone`, `Serialize` or secret getter on opened credential
   types.** `OpenedCredentialV1` has none of those implementations and exposes
   only non-secret summary accessors. The eight local-core trybuild cases prove
   the absence of `Debug`, `Display`, `Clone`, `Copy`, `Serialize`, a secret
   getter, and public record/revision constructors. `SecretValueV1` is private,
   zeroizing, and also has none of the secret-exposing traits.
4. **No actual credential-shaped fixture.** All secret-like fixture bytes begin
   with `DEMO_VALUE_ONLY_`; provider/account/project values are visibly fictional
   (`Example AI Workshop`, `demo-account`, `demo-project`) and URLs use the
   reserved `.invalid` domain. The bounded repository scan found no credential
   pattern.
5. **No persistence, network, process execution, clipboard or browser code.**
   Source inspection found no disk/database adapter, socket or HTTP client,
   child-process launcher, clipboard API, browser runtime or webview in
   `vault-local-core`. `BrowserExtension` is only a serialized consumer-type enum
   value, not browser integration code. The resolved dependency tree contains
   no runtime dependency for those capabilities.
6. **No recovery Key Slot implementation.** Neither the local-core public API nor
   its dependencies implement recovery keys, Key Slots or trusted-device key
   storage. Recovery remains a separately gated follow-up plan.
7. **Session epoch equals record-context epoch.** Both seal and open call
   `validate_session_context`; it returns `AuthenticationFailed` when the session
   epoch differs from the context epoch. `epoch_binding.rs` covers the mismatched
   seal and open paths.
8. **Future versions preserve ciphertext and cannot be overwritten.** Inner
   schema version 2 and outer wire version 1 return the read-only
   `UpgradeRequired` outcome. `future_inner_and_outer_versions_require_upgrade_without_mutation`
   compares the envelope bytes before and after open. The public local-core API
   has no arbitrary update or overwrite entry point.

## Explicit exclusions

This verified slice remains synthetic-only. It does not accept, import or store
real identifiers, passwords, API keys, Secrets, recovery keys, session cookies
or private-vault data. Public creation does not accept free-form strings, paste,
imports, deep links, browser-extension messages, CLI input or MCP input.

It does not implement SQLite, a disk database, file persistence, an outbox,
expected-head CAS, immutable persistent revisions, search indexes, a rotation
workflow, conflict handling, Android or web UI, a recovery Key Slot, trusted
devices, server sync, plugins, MCP execution or actual Secret support. GitHub is
only a backup for source code and design documents; it is not a backup for vault
data. Actual credentials must not be entered into this alpha.

The current password envelope remains the initial `key_epoch = 1` design. The
local payload limit is 60,000 encoded bytes and the fixed canonical-CBOR and
padding-bucket rules remain those committed in `contracts/local-v1`.

## Validation limit

The existing committed regression vectors verify compatibility with this
repository's expected bytes. They are **not independent cryptographic
validation** and must not be represented as an external review, audit,
penetration test or proof of cryptographic correctness.
