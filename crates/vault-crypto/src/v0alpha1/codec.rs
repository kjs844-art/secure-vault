use core::convert::Infallible;

use minicbor::{Decoder, Encoder, encode::Write};

use crate::CryptoError;

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

const CANDIDATE_MEMORY_KIB: u64 = 65_536;
const CANDIDATE_TIME_COST: u64 = 3;
const CANDIDATE_LANES: u64 = 4;

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
struct PasswordEnvelopeFields<'a> {
    wire_version: u64,
    suite_id: u64,
    object_kind: u64,
    salt: &'a [u8],
    memory_kib: u64,
    time_cost: u64,
    lanes: u64,
    vault_commitment: &'a [u8],
    root_nonce: &'a [u8],
    wrapped_root_key: &'a [u8],
}

#[derive(Clone, Copy)]
struct RecordEnvelopeFields<'a> {
    wire_version: u64,
    suite_id: u64,
    object_kind: u64,
    vault_commitment: &'a [u8],
    opaque_record_id: &'a [u8],
    revision_id: &'a [u8],
    key_epoch: u64,
    padding_bucket: u64,
    item_key_nonce: &'a [u8],
    wrapped_item_key: &'a [u8],
    body_nonce: &'a [u8],
    encrypted_body: &'a [u8],
}

/// Validate a password envelope without exposing parsed or mutable fields.
pub fn inspect_password_envelope_v0alpha1(input: &[u8]) -> Result<(), CryptoError> {
    decode_password_envelope(input).map(|_| ())
}

/// Validate a record envelope without exposing parsed or mutable fields.
pub fn inspect_record_envelope_v0alpha1(input: &[u8]) -> Result<(), CryptoError> {
    decode_record_envelope(input).map(|_| ())
}

fn decode_password_envelope(input: &[u8]) -> Result<PasswordEnvelopeFields<'_>, CryptoError> {
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

fn decode_record_envelope(input: &[u8]) -> Result<RecordEnvelopeFields<'_>, CryptoError> {
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
    if suite_id != SUITE_ID {
        return Err(CryptoError::UnsupportedSuite);
    }
    if object_kind != expected_kind {
        return Err(CryptoError::NonCanonicalEncoding);
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
    if fields.memory_kib != CANDIDATE_MEMORY_KIB
        || fields.time_cost != CANDIDATE_TIME_COST
        || fields.lanes != CANDIDATE_LANES
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
    match padding_bucket {
        1_024 | 4_096 | 16_384 | 61_440 => Ok(padding_bucket as usize),
        _ => Err(CryptoError::LimitsExceeded),
    }
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
