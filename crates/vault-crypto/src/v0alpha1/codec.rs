use core::convert::Infallible;

use minicbor::{Decoder, Encoder, encode::Write};

use crate::{
    CryptoError, KeyEpoch, OpaqueRecordId, PaddingBucketV0Alpha1, RecordContextV0Alpha1,
    RevisionId, VaultCommitment,
};

use super::kdf::{CANDIDATE_LANES, CANDIDATE_MEMORY_KIB, CANDIDATE_TIME_COST};

const MAX_ENVELOPE_BYTES: usize = 65_536;
const WIRE_VERSION: u64 = 0;
const SUITE_ID: u64 = 0xA101;
const PASSWORD_OBJECT_KIND: u64 = 1;
const RECORD_OBJECT_KIND: u64 = 2;

const PASSWORD_FIELD_COUNT: u64 = 10;
const RECORD_FIELD_COUNT: u64 = 12;

const SALT_BYTES: usize = 16;
const VAULT_COMMITMENT_BYTES: usize = 32;
const OPAQUE_RECORD_ID_BYTES: usize = 16;
const REVISION_ID_BYTES: usize = 32;
const NONCE_BYTES: usize = 24;
const WRAPPED_KEY_BYTES: usize = 48;
const AUTH_TAG_BYTES: usize = 16;

const PASSWORD_ROOT_DOMAIN: &[u8] = b"secure-vault/v0alpha1/password-root-wrap";
const ITEM_DEK_DOMAIN: &[u8] = b"secure-vault/v0alpha1/item-dek-wrap";
const ITEM_BODY_DOMAIN: &[u8] = b"secure-vault/v0alpha1/item-body";
const PASSWORD_AAD_FIELD_COUNT: u64 = 9;
const RECORD_AAD_FIELD_COUNT: u64 = 9;

struct CanonicalComparator<'a> {
    expected: &'a [u8],
    position: usize,
    matches: bool,
}

impl<'a> CanonicalComparator<'a> {
    const fn new(expected: &'a [u8]) -> Self {
        Self {
            expected,
            position: 0,
            matches: true,
        }
    }

    fn is_exact_match(&self) -> bool {
        self.matches && self.position == self.expected.len()
    }
}

impl Write for CanonicalComparator<'_> {
    type Error = Infallible;

    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error> {
        let Some(end) = self.position.checked_add(bytes.len()) else {
            self.matches = false;
            self.position = usize::MAX;
            return Ok(());
        };

        if self.expected.get(self.position..end) != Some(bytes) {
            self.matches = false;
        }
        self.position = end;
        Ok(())
    }
}

#[derive(Clone, Copy)]
pub(crate) struct PasswordEnvelopeFields<'a> {
    pub(crate) wire_version: u64,
    pub(crate) suite_id: u64,
    pub(crate) object_kind: u64,
    pub(crate) salt: &'a [u8],
    pub(crate) memory_kib: u64,
    pub(crate) time_cost: u64,
    pub(crate) lanes: u64,
    pub(crate) vault_commitment: &'a [u8],
    pub(crate) root_nonce: &'a [u8],
    pub(crate) wrapped_root_key: &'a [u8],
}

#[derive(Clone, Copy)]
pub(crate) struct RecordEnvelopeFields<'a> {
    pub(crate) wire_version: u64,
    pub(crate) suite_id: u64,
    pub(crate) object_kind: u64,
    pub(crate) vault_commitment: &'a [u8],
    pub(crate) opaque_record_id: &'a [u8],
    pub(crate) revision_id: &'a [u8],
    pub(crate) key_epoch: u64,
    pub(crate) padding_bucket: u64,
    pub(crate) item_key_nonce: &'a [u8],
    pub(crate) wrapped_item_key: &'a [u8],
    pub(crate) body_nonce: &'a [u8],
    pub(crate) encrypted_body: &'a [u8],
}

pub(crate) enum PasswordEnvelopeStorageFields {
    Current {
        wire_version: u32,
        suite_id: u32,
        vault_commitment: VaultCommitment,
    },
    UnsupportedSuite {
        wire_version: u32,
        suite_id: u32,
    },
}

pub(crate) enum RecordEnvelopeStorageFields {
    Current {
        wire_version: u32,
        suite_id: u32,
        vault_commitment: VaultCommitment,
        record_id: OpaqueRecordId,
        revision_id: RevisionId,
        key_epoch: KeyEpoch,
        padding_bucket: PaddingBucketV0Alpha1,
    },
    UnsupportedSuite {
        wire_version: u32,
        suite_id: u32,
    },
}

/// Validate a password envelope without exposing parsed or mutable fields.
pub fn inspect_password_envelope_v0alpha1(input: &[u8]) -> Result<(), CryptoError> {
    decode_password_envelope(input).map(|_| ())
}

/// Validate a record envelope without exposing parsed or mutable fields.
pub fn inspect_record_envelope_v0alpha1(input: &[u8]) -> Result<(), CryptoError> {
    decode_record_envelope(input).map(|_| ())
}

pub(crate) fn decode_password_envelope(
    input: &[u8],
) -> Result<PasswordEnvelopeFields<'_>, CryptoError> {
    reject_if_over_64_kib(input)?;
    let fields = parse_fixed_password_array(input)?;
    ensure_password_envelope_is_canonical(input, &fields)?;
    validate_header(
        fields.wire_version,
        fields.suite_id,
        fields.object_kind,
        PASSWORD_OBJECT_KIND,
    )?;
    validate_password_field_lengths(&fields)?;
    validate_exact_candidate_kdf(&fields)?;
    Ok(fields)
}

pub(crate) fn decode_password_envelope_for_storage(
    input: &[u8],
) -> Result<PasswordEnvelopeStorageFields, CryptoError> {
    let fields = match decode_password_envelope(input) {
        Ok(fields) => fields,
        Err(CryptoError::UnsupportedSuite) => decode_password_envelope_shape(input)?,
        Err(error) => return Err(error),
    };
    let wire_version = checked_storage_u32(fields.wire_version)?;
    let suite_id = checked_storage_u32(fields.suite_id)?;

    if fields.suite_id != SUITE_ID {
        return Ok(PasswordEnvelopeStorageFields::UnsupportedSuite {
            wire_version,
            suite_id,
        });
    }

    Ok(PasswordEnvelopeStorageFields::Current {
        wire_version,
        suite_id,
        vault_commitment: VaultCommitment::from_bytes(copy_array(fields.vault_commitment)?),
    })
}

fn decode_password_envelope_shape(input: &[u8]) -> Result<PasswordEnvelopeFields<'_>, CryptoError> {
    reject_if_over_64_kib(input)?;
    let fields = parse_fixed_password_array(input)?;
    ensure_password_envelope_is_canonical(input, &fields)?;
    validate_current_wire_and_object_kind(
        fields.wire_version,
        fields.object_kind,
        PASSWORD_OBJECT_KIND,
    )?;
    validate_password_field_lengths(&fields)?;
    validate_exact_candidate_kdf(&fields)?;
    Ok(fields)
}

pub(crate) fn encode_password_envelope(
    salt: &[u8; SALT_BYTES],
    vault_commitment: &[u8; VAULT_COMMITMENT_BYTES],
    root_nonce: &[u8; NONCE_BYTES],
    wrapped_root_key: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if wrapped_root_key.len() != WRAPPED_KEY_BYTES {
        return Err(CryptoError::InvalidLength);
    }

    let mut encoder = Encoder::new(Vec::with_capacity(192));
    encoder.array(PASSWORD_FIELD_COUNT).map_err(encode_error)?;
    encoder.u64(WIRE_VERSION).map_err(encode_error)?;
    encoder.u64(SUITE_ID).map_err(encode_error)?;
    encoder.u64(PASSWORD_OBJECT_KIND).map_err(encode_error)?;
    encoder.bytes(salt).map_err(encode_error)?;
    encoder
        .u64(u64::from(CANDIDATE_MEMORY_KIB))
        .map_err(encode_error)?;
    encoder
        .u64(u64::from(CANDIDATE_TIME_COST))
        .map_err(encode_error)?;
    encoder
        .u64(u64::from(CANDIDATE_LANES))
        .map_err(encode_error)?;
    encoder.bytes(vault_commitment).map_err(encode_error)?;
    encoder.bytes(root_nonce).map_err(encode_error)?;
    encoder.bytes(wrapped_root_key).map_err(encode_error)?;

    let encoded = encoder.into_writer();
    reject_if_over_64_kib(&encoded)?;
    Ok(encoded)
}

pub(crate) fn password_root_aad(
    salt: &[u8; SALT_BYTES],
    vault_commitment: &[u8; VAULT_COMMITMENT_BYTES],
) -> Result<Vec<u8>, CryptoError> {
    let mut encoder = Encoder::new(Vec::with_capacity(128));
    encoder
        .array(PASSWORD_AAD_FIELD_COUNT)
        .map_err(encode_error)?;
    encoder.bytes(PASSWORD_ROOT_DOMAIN).map_err(encode_error)?;
    encoder.u64(WIRE_VERSION).map_err(encode_error)?;
    encoder.u64(SUITE_ID).map_err(encode_error)?;
    encoder.u64(PASSWORD_OBJECT_KIND).map_err(encode_error)?;
    encoder.bytes(salt).map_err(encode_error)?;
    encoder
        .u64(u64::from(CANDIDATE_MEMORY_KIB))
        .map_err(encode_error)?;
    encoder
        .u64(u64::from(CANDIDATE_TIME_COST))
        .map_err(encode_error)?;
    encoder
        .u64(u64::from(CANDIDATE_LANES))
        .map_err(encode_error)?;
    encoder.bytes(vault_commitment).map_err(encode_error)?;
    Ok(encoder.into_writer())
}

pub(crate) fn encode_record_envelope(
    context: &RecordContextV0Alpha1,
    item_key_nonce: &[u8; NONCE_BYTES],
    wrapped_item_key: &[u8],
    body_nonce: &[u8; NONCE_BYTES],
    encrypted_body: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if wrapped_item_key.len() != WRAPPED_KEY_BYTES {
        return Err(CryptoError::InvalidLength);
    }
    validate_encrypted_body_length(encrypted_body, context.padding_bucket_bytes())?;

    let mut encoder = Encoder::new(Vec::with_capacity(
        context.padding_bucket_bytes().saturating_add(256),
    ));
    encoder.array(RECORD_FIELD_COUNT).map_err(encode_error)?;
    encoder.u64(WIRE_VERSION).map_err(encode_error)?;
    encoder.u64(SUITE_ID).map_err(encode_error)?;
    encoder.u64(RECORD_OBJECT_KIND).map_err(encode_error)?;
    encoder
        .bytes(context.commitment_bytes())
        .map_err(encode_error)?;
    encoder
        .bytes(context.record_id_bytes())
        .map_err(encode_error)?;
    encoder
        .bytes(context.revision_id_bytes())
        .map_err(encode_error)?;
    encoder
        .u64(u64::from(context.key_epoch_value()))
        .map_err(encode_error)?;
    encoder
        .u64(context.padding_bucket_bytes() as u64)
        .map_err(encode_error)?;
    encoder.bytes(item_key_nonce).map_err(encode_error)?;
    encoder.bytes(wrapped_item_key).map_err(encode_error)?;
    encoder.bytes(body_nonce).map_err(encode_error)?;
    encoder.bytes(encrypted_body).map_err(encode_error)?;

    let encoded = encoder.into_writer();
    reject_if_over_64_kib(&encoded)?;
    Ok(encoded)
}

pub(crate) fn item_dek_aad(context: &RecordContextV0Alpha1) -> Result<Vec<u8>, CryptoError> {
    record_aad(ITEM_DEK_DOMAIN, context)
}

pub(crate) fn item_body_aad(context: &RecordContextV0Alpha1) -> Result<Vec<u8>, CryptoError> {
    record_aad(ITEM_BODY_DOMAIN, context)
}

fn record_aad(domain: &[u8], context: &RecordContextV0Alpha1) -> Result<Vec<u8>, CryptoError> {
    let mut encoder = Encoder::new(Vec::with_capacity(160));
    encoder
        .array(RECORD_AAD_FIELD_COUNT)
        .map_err(encode_error)?;
    encoder.bytes(domain).map_err(encode_error)?;
    encoder.u64(WIRE_VERSION).map_err(encode_error)?;
    encoder.u64(SUITE_ID).map_err(encode_error)?;
    encoder.u64(RECORD_OBJECT_KIND).map_err(encode_error)?;
    encoder
        .bytes(context.commitment_bytes())
        .map_err(encode_error)?;
    encoder
        .bytes(context.record_id_bytes())
        .map_err(encode_error)?;
    encoder
        .bytes(context.revision_id_bytes())
        .map_err(encode_error)?;
    encoder
        .u64(u64::from(context.key_epoch_value()))
        .map_err(encode_error)?;
    encoder
        .u64(context.padding_bucket_bytes() as u64)
        .map_err(encode_error)?;
    Ok(encoder.into_writer())
}

pub(crate) fn decode_record_envelope(
    input: &[u8],
) -> Result<RecordEnvelopeFields<'_>, CryptoError> {
    reject_if_over_64_kib(input)?;
    let fields = parse_fixed_record_array(input)?;
    ensure_record_envelope_is_canonical(input, &fields)?;
    validate_header(
        fields.wire_version,
        fields.suite_id,
        fields.object_kind,
        RECORD_OBJECT_KIND,
    )?;
    validate_record_field_lengths(&fields)?;
    validate_record_epoch(fields.key_epoch)?;
    let bucket = validate_padding_bucket(fields.padding_bucket)?;
    validate_encrypted_body_length(fields.encrypted_body, bucket)?;
    Ok(fields)
}

pub(crate) fn decode_record_envelope_for_storage(
    input: &[u8],
) -> Result<RecordEnvelopeStorageFields, CryptoError> {
    let fields = match decode_record_envelope(input) {
        Ok(fields) => fields,
        Err(CryptoError::UnsupportedSuite) => decode_record_envelope_shape(input)?,
        Err(error) => return Err(error),
    };
    let wire_version = checked_storage_u32(fields.wire_version)?;
    let suite_id = checked_storage_u32(fields.suite_id)?;

    if fields.suite_id != SUITE_ID {
        return Ok(RecordEnvelopeStorageFields::UnsupportedSuite {
            wire_version,
            suite_id,
        });
    }

    Ok(RecordEnvelopeStorageFields::Current {
        wire_version,
        suite_id,
        vault_commitment: VaultCommitment::from_bytes(copy_array(fields.vault_commitment)?),
        record_id: OpaqueRecordId::from_bytes(copy_array(fields.opaque_record_id)?),
        revision_id: RevisionId::from_bytes(copy_array(fields.revision_id)?),
        key_epoch: KeyEpoch::new(checked_storage_u32(fields.key_epoch)?)?,
        padding_bucket: padding_bucket_from_value(fields.padding_bucket)?,
    })
}

fn decode_record_envelope_shape(input: &[u8]) -> Result<RecordEnvelopeFields<'_>, CryptoError> {
    reject_if_over_64_kib(input)?;
    let fields = parse_fixed_record_array(input)?;
    ensure_record_envelope_is_canonical(input, &fields)?;
    validate_current_wire_and_object_kind(
        fields.wire_version,
        fields.object_kind,
        RECORD_OBJECT_KIND,
    )?;
    validate_record_field_lengths(&fields)?;
    validate_record_epoch(fields.key_epoch)?;
    let bucket = validate_padding_bucket(fields.padding_bucket)?;
    validate_encrypted_body_length(fields.encrypted_body, bucket)?;
    Ok(fields)
}

fn reject_if_over_64_kib(input: &[u8]) -> Result<(), CryptoError> {
    if input.len() > MAX_ENVELOPE_BYTES {
        return Err(CryptoError::LimitsExceeded);
    }
    Ok(())
}

fn parse_fixed_password_array(input: &[u8]) -> Result<PasswordEnvelopeFields<'_>, CryptoError> {
    let mut decoder = Decoder::new(input);
    if decoder.array().map_err(decode_error)? != Some(PASSWORD_FIELD_COUNT) {
        return Err(CryptoError::NonCanonicalEncoding);
    }

    let fields = PasswordEnvelopeFields {
        wire_version: decoder.u64().map_err(decode_error)?,
        suite_id: decoder.u64().map_err(decode_error)?,
        object_kind: decoder.u64().map_err(decode_error)?,
        salt: decoder.bytes().map_err(decode_error)?,
        memory_kib: decoder.u64().map_err(decode_error)?,
        time_cost: decoder.u64().map_err(decode_error)?,
        lanes: decoder.u64().map_err(decode_error)?,
        vault_commitment: decoder.bytes().map_err(decode_error)?,
        root_nonce: decoder.bytes().map_err(decode_error)?,
        wrapped_root_key: decoder.bytes().map_err(decode_error)?,
    };

    if decoder.position() != input.len() {
        return Err(CryptoError::NonCanonicalEncoding);
    }
    Ok(fields)
}

fn parse_fixed_record_array(input: &[u8]) -> Result<RecordEnvelopeFields<'_>, CryptoError> {
    let mut decoder = Decoder::new(input);
    if decoder.array().map_err(decode_error)? != Some(RECORD_FIELD_COUNT) {
        return Err(CryptoError::NonCanonicalEncoding);
    }

    let fields = RecordEnvelopeFields {
        wire_version: decoder.u64().map_err(decode_error)?,
        suite_id: decoder.u64().map_err(decode_error)?,
        object_kind: decoder.u64().map_err(decode_error)?,
        vault_commitment: decoder.bytes().map_err(decode_error)?,
        opaque_record_id: decoder.bytes().map_err(decode_error)?,
        revision_id: decoder.bytes().map_err(decode_error)?,
        key_epoch: decoder.u64().map_err(decode_error)?,
        padding_bucket: decoder.u64().map_err(decode_error)?,
        item_key_nonce: decoder.bytes().map_err(decode_error)?,
        wrapped_item_key: decoder.bytes().map_err(decode_error)?,
        body_nonce: decoder.bytes().map_err(decode_error)?,
        encrypted_body: decoder.bytes().map_err(decode_error)?,
    };

    if decoder.position() != input.len() {
        return Err(CryptoError::NonCanonicalEncoding);
    }
    Ok(fields)
}

fn validate_header(
    wire_version: u64,
    suite_id: u64,
    object_kind: u64,
    expected_kind: u64,
) -> Result<(), CryptoError> {
    if wire_version != WIRE_VERSION {
        return Err(CryptoError::UnsupportedVersion);
    }
    validate_suite(suite_id)?;
    if object_kind != expected_kind {
        return Err(CryptoError::NonCanonicalEncoding);
    }
    Ok(())
}

fn validate_current_wire_and_object_kind(
    wire_version: u64,
    object_kind: u64,
    expected_kind: u64,
) -> Result<(), CryptoError> {
    if wire_version != WIRE_VERSION {
        return Err(CryptoError::UnsupportedVersion);
    }
    if object_kind != expected_kind {
        return Err(CryptoError::NonCanonicalEncoding);
    }
    Ok(())
}

fn validate_suite(suite_id: u64) -> Result<(), CryptoError> {
    if suite_id != SUITE_ID {
        return Err(CryptoError::UnsupportedSuite);
    }
    Ok(())
}

fn validate_password_field_lengths(fields: &PasswordEnvelopeFields<'_>) -> Result<(), CryptoError> {
    if fields.salt.len() != SALT_BYTES
        || fields.vault_commitment.len() != VAULT_COMMITMENT_BYTES
        || fields.root_nonce.len() != NONCE_BYTES
        || fields.wrapped_root_key.len() != WRAPPED_KEY_BYTES
    {
        return Err(CryptoError::InvalidLength);
    }
    Ok(())
}

fn validate_exact_candidate_kdf(fields: &PasswordEnvelopeFields<'_>) -> Result<(), CryptoError> {
    if fields.memory_kib != u64::from(CANDIDATE_MEMORY_KIB)
        || fields.time_cost != u64::from(CANDIDATE_TIME_COST)
        || fields.lanes != u64::from(CANDIDATE_LANES)
    {
        return Err(CryptoError::KdfParamsRejected);
    }
    Ok(())
}

fn validate_record_field_lengths(fields: &RecordEnvelopeFields<'_>) -> Result<(), CryptoError> {
    if fields.vault_commitment.len() != VAULT_COMMITMENT_BYTES
        || fields.opaque_record_id.len() != OPAQUE_RECORD_ID_BYTES
        || fields.revision_id.len() != REVISION_ID_BYTES
        || fields.item_key_nonce.len() != NONCE_BYTES
        || fields.wrapped_item_key.len() != WRAPPED_KEY_BYTES
        || fields.body_nonce.len() != NONCE_BYTES
    {
        return Err(CryptoError::InvalidLength);
    }
    Ok(())
}

fn validate_record_epoch(key_epoch: u64) -> Result<(), CryptoError> {
    if key_epoch == 0 || key_epoch > u64::from(u32::MAX) {
        return Err(CryptoError::InvalidLength);
    }
    Ok(())
}

fn validate_padding_bucket(padding_bucket: u64) -> Result<usize, CryptoError> {
    Ok(padding_bucket_from_value(padding_bucket)?.byte_len())
}

fn padding_bucket_from_value(padding_bucket: u64) -> Result<PaddingBucketV0Alpha1, CryptoError> {
    match padding_bucket {
        1_024 => Ok(PaddingBucketV0Alpha1::Bytes1024),
        4_096 => Ok(PaddingBucketV0Alpha1::Bytes4096),
        16_384 => Ok(PaddingBucketV0Alpha1::Bytes16384),
        61_440 => Ok(PaddingBucketV0Alpha1::Bytes61440),
        _ => Err(CryptoError::LimitsExceeded),
    }
}

fn checked_storage_u32(value: u64) -> Result<u32, CryptoError> {
    u32::try_from(value).map_err(|_| CryptoError::LimitsExceeded)
}

fn copy_array<const N: usize>(input: &[u8]) -> Result<[u8; N], CryptoError> {
    input.try_into().map_err(|_| CryptoError::InvalidLength)
}

fn validate_encrypted_body_length(
    encrypted_body: &[u8],
    padding_bucket: usize,
) -> Result<(), CryptoError> {
    let expected = padding_bucket
        .checked_add(AUTH_TAG_BYTES)
        .ok_or(CryptoError::LimitsExceeded)?;
    if encrypted_body.len() != expected {
        return Err(CryptoError::InvalidLength);
    }
    Ok(())
}

fn ensure_password_envelope_is_canonical(
    input: &[u8],
    fields: &PasswordEnvelopeFields<'_>,
) -> Result<(), CryptoError> {
    let mut encoder = Encoder::new(CanonicalComparator::new(input));
    encoder.array(PASSWORD_FIELD_COUNT).map_err(encode_error)?;
    encoder.u64(fields.wire_version).map_err(encode_error)?;
    encoder.u64(fields.suite_id).map_err(encode_error)?;
    encoder.u64(fields.object_kind).map_err(encode_error)?;
    encoder.bytes(fields.salt).map_err(encode_error)?;
    encoder.u64(fields.memory_kib).map_err(encode_error)?;
    encoder.u64(fields.time_cost).map_err(encode_error)?;
    encoder.u64(fields.lanes).map_err(encode_error)?;
    encoder
        .bytes(fields.vault_commitment)
        .map_err(encode_error)?;
    encoder.bytes(fields.root_nonce).map_err(encode_error)?;
    encoder
        .bytes(fields.wrapped_root_key)
        .map_err(encode_error)?;
    if !encoder.into_writer().is_exact_match() {
        return Err(CryptoError::NonCanonicalEncoding);
    }
    Ok(())
}

fn ensure_record_envelope_is_canonical(
    input: &[u8],
    fields: &RecordEnvelopeFields<'_>,
) -> Result<(), CryptoError> {
    let mut encoder = Encoder::new(CanonicalComparator::new(input));
    encoder.array(RECORD_FIELD_COUNT).map_err(encode_error)?;
    encoder.u64(fields.wire_version).map_err(encode_error)?;
    encoder.u64(fields.suite_id).map_err(encode_error)?;
    encoder.u64(fields.object_kind).map_err(encode_error)?;
    encoder
        .bytes(fields.vault_commitment)
        .map_err(encode_error)?;
    encoder
        .bytes(fields.opaque_record_id)
        .map_err(encode_error)?;
    encoder.bytes(fields.revision_id).map_err(encode_error)?;
    encoder.u64(fields.key_epoch).map_err(encode_error)?;
    encoder.u64(fields.padding_bucket).map_err(encode_error)?;
    encoder.bytes(fields.item_key_nonce).map_err(encode_error)?;
    encoder
        .bytes(fields.wrapped_item_key)
        .map_err(encode_error)?;
    encoder.bytes(fields.body_nonce).map_err(encode_error)?;
    encoder.bytes(fields.encrypted_body).map_err(encode_error)?;
    if !encoder.into_writer().is_exact_match() {
        return Err(CryptoError::NonCanonicalEncoding);
    }
    Ok(())
}

fn decode_error(_: minicbor::decode::Error) -> CryptoError {
    CryptoError::NonCanonicalEncoding
}

fn encode_error(_: minicbor::encode::Error<Infallible>) -> CryptoError {
    CryptoError::NonCanonicalEncoding
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        KeyEpoch, OpaqueRecordId, PaddingBucketV0Alpha1, RecordContextV0Alpha1, RevisionId,
        VaultCommitment,
    };

    #[test]
    fn password_root_aad_matches_the_hand_derived_contract_bytes() {
        let salt = [0x11; 16];
        let commitment = [0x22; 32];
        let mut expected = vec![0x89, 0x58, 0x28];
        expected.extend_from_slice(b"secure-vault/v0alpha1/password-root-wrap");
        expected.extend_from_slice(&[0x00, 0x19, 0xa1, 0x01, 0x01, 0x50]);
        expected.extend_from_slice(&salt);
        expected.extend_from_slice(&[0x1a, 0x00, 0x01, 0x00, 0x00, 0x03, 0x04, 0x58, 0x20]);
        expected.extend_from_slice(&commitment);

        assert_eq!(password_root_aad(&salt, &commitment).unwrap(), expected);
    }

    #[test]
    fn item_aad_uses_two_hand_derived_domain_separated_encodings() {
        let context = RecordContextV0Alpha1::new(
            VaultCommitment::from_bytes([0x11; 32]),
            OpaqueRecordId::from_bytes([0x22; 16]),
            RevisionId::from_bytes([0x33; 32]),
            KeyEpoch::new(1).unwrap(),
            PaddingBucketV0Alpha1::Bytes1024,
        );
        let mut common_suffix = vec![0x00, 0x19, 0xa1, 0x01, 0x02, 0x58, 0x20];
        common_suffix.extend_from_slice(&[0x11; 32]);
        common_suffix.push(0x50);
        common_suffix.extend_from_slice(&[0x22; 16]);
        common_suffix.extend_from_slice(&[0x58, 0x20]);
        common_suffix.extend_from_slice(&[0x33; 32]);
        common_suffix.extend_from_slice(&[0x01, 0x19, 0x04, 0x00]);

        let mut expected_dek = vec![0x89, 0x58, 0x23];
        expected_dek.extend_from_slice(b"secure-vault/v0alpha1/item-dek-wrap");
        expected_dek.extend_from_slice(&common_suffix);

        let mut expected_body = vec![0x89, 0x58, 0x1f];
        expected_body.extend_from_slice(b"secure-vault/v0alpha1/item-body");
        expected_body.extend_from_slice(&common_suffix);

        assert_eq!(item_dek_aad(&context).unwrap(), expected_dek);
        assert_eq!(item_body_aad(&context).unwrap(), expected_body);
        assert_ne!(expected_dek, expected_body);
    }
}
