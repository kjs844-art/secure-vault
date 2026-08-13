# v0alpha1 Domain Separation and AAD

## Exact domain byte strings

Each domain is the exact ASCII/UTF-8 byte sequence shown below. The domain occupies a CBOR byte string (`bstr`), not a CBOR text string, and has no trailing NUL or newline.

```text
secure-vault/v0alpha1/password-root-wrap
secure-vault/v0alpha1/item-dek-wrap
secure-vault/v0alpha1/item-body
```

## Password-root AAD

Password-root wrapping uses the first domain and the deterministic CBOR encoding of this fixed array:

```text
[domain, wire_version, suite_id, object_kind, salt,
 memory_kib, time_cost, lanes, vault_commitment]
```

For v0alpha1, `wire_version` is `0`, `suite_id` is `41217`, and `object_kind` is `1`. `salt` and `vault_commitment` are CBOR byte strings with sizes fixed by the envelope contract.

## Item AAD

Item-DEK wrapping uses `secure-vault/v0alpha1/item-dek-wrap`. Item-body encryption uses `secure-vault/v0alpha1/item-body`. Each operation deterministically CBOR-encodes the same fixed context array with its respective domain:

```text
[domain, wire_version, suite_id, object_kind, vault_commitment,
 opaque_record_id, revision_id, key_epoch, padding_bucket]
```

For v0alpha1, `wire_version` is `0`, `suite_id` is `41217`, and `object_kind` is `2`. Byte-string lengths, the inclusive `key_epoch` range `1..=4294967295`, and allowed `padding_bucket` values are defined by `envelope.cddl`.

No field may be omitted, reordered, converted between CBOR byte and text strings, or encoded non-canonically. An AAD encoding change requires a new suite ID or wire version; it must not silently reuse `0xA101`.
