# vault-local-core (synthetic-only)

> Warning: This alpha crate accepts and stores only synthetic fixture data. It is
> not approved for real identifiers, passwords, API keys, secrets, recovery
> keys, session cookies, or private-vault data.

## Explicit exclusions

This Task 2 crate does not implement SQLite or file storage, outbox processing,
expected-head CAS, search indexes, rotation workflows, conflict handling,
Android or web UI, recovery keys, trusted devices, server sync, plugins, MCP
execution, or real-secret support. It offers no public input API for free-form
strings, paste, import, deep links, browser-extension messages, CLI input, or
MCP input.

The only permitted fixture values use the `DEMO_VALUE_ONLY_` prefix and clearly
fictional service, account, and project names.
