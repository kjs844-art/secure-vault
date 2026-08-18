# Secure Vault storage schema v1 contract

This directory is the checked-in, synthetic-only SQLite storage contract.
`schema-v1.sql` is the single source of truth for the v1 DDL and is embedded by
the Rust adapter without copying the SQL into source code.

The version fields are deliberately independent:

- SQLite `user_version` is the storage schema version.
- `password_wire_version` and revision `wire_version` identify outer crypto envelopes.
- Inner item schema versions remain inside authenticated ciphertext.
- `suite_id` identifies the crypto suite; `key_epoch` identifies a vault key epoch.

A later Android/Room adapter must preserve the exact BLOB/INTEGER representation,
constraints, foreign keys, and immutable triggers. This contract does not authorize
real credentials, migrations, backup/export, recovery, synchronization, or plaintext
search indexes.
