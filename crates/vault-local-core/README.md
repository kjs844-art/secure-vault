# vault-local-core (synthetic-only)

> Warning: This alpha crate accepts and stores only synthetic fixture data. It is
> not approved for real identifiers, passwords, API keys, secrets, recovery
> keys, session cookies, or private-vault data.

## Explicit exclusions

This crate now implements the typed `CredentialItemV1` payload and exactly three
synthetic relationship fixtures: an unconnected API key, one MCP connection,
and multiple consumers. Tests and the example verify authenticated restore after
the original session is dropped and the synthetic vault is unlocked again.

It does not implement a disk database or file storage, outbox processing,
expected-head CAS, search, rotation workflows, conflict handling, Android or web
UI, a recovery Key Slot, trusted devices, server sync, plugins, MCP execution,
or actual Secret support. It offers no public input API for free-form strings,
paste, import, deep links, browser-extension messages, CLI input, or MCP input.

The only permitted fixture values use the `DEMO_VALUE_ONLY_` prefix and clearly
fictional service, account, and project names.

Do not enter actual credentials into this alpha. GitHub backs up source code and
design documents only; it is not a backup destination for vault data.
