use minicbor::{Decoder, Encoder};

use crate::{
    CryptoError, KeyEpoch, OpaqueRecordId, PaddingBucketV0Alpha1, RevisionId, VaultCommitment,
};

use super::codec::{
    PasswordEnvelopeStorageFields, RecordEnvelopeStorageFields,
    decode_password_envelope_for_storage, decode_record_envelope_for_storage,
};

const MAX_ENVELOPE_BYTES: usize = 65_536;
const CURRENT_WIRE_VERSION: u32 = 0;

pub enum PasswordEnvelopeStorageDispositionV1<'a> {
    Current(PasswordEnvelopeStorageInspectionV1<'a>),
    FutureWire(FutureWireStorageInspectionV1),
    UnsupportedSuite(CurrentSuiteStorageInspectionV1),
}

pub enum RecordEnvelopeStorageDispositionV1<'a> {
    Current(RecordEnvelopeStorageInspectionV1<'a>),
    FutureWire(FutureWireStorageInspectionV1),
    UnsupportedSuite(CurrentSuiteStorageInspectionV1),
}

pub struct PasswordEnvelopeStorageInspectionV1<'a> {
    wire_version: u32,
    suite_id: u32,
    vault_commitment: VaultCommitment,
    envelope: &'a [u8],
}

pub struct RecordEnvelopeStorageInspectionV1<'a> {
    wire_version: u32,
    suite_id: u32,
    vault_commitment: VaultCommitment,
    record_id: OpaqueRecordId,
    revision_id: RevisionId,
    key_epoch: KeyEpoch,
    padding_bucket: PaddingBucketV0Alpha1,
    envelope: &'a [u8],
}

pub struct PasswordEnvelopeBootstrapProjectionV1<'a> {
    wire_version: u32,
    suite_id: u32,
    vault_commitment: [u8; 32],
    envelope: &'a [u8],
}

pub struct FutureWireStorageInspectionV1 {
    wire_version: u32,
    envelope: Vec<u8>,
}

pub struct CurrentSuiteStorageInspectionV1 {
    wire_version: u32,
    suite_id: u32,
    envelope: Vec<u8>,
}

/// Classify a password envelope for bounded, session-free storage handling.
pub fn inspect_password_envelope_for_storage_v1(
    input: &[u8],
) -> Result<PasswordEnvelopeStorageDispositionV1<'_>, CryptoError> {
    match inspect_outer_wire_version(input)? {
        version if version > CURRENT_WIRE_VERSION => Ok(
            PasswordEnvelopeStorageDispositionV1::FutureWire(FutureWireStorageInspectionV1 {
                wire_version: version,
                envelope: input.to_vec(),
            }),
        ),
        CURRENT_WIRE_VERSION => match decode_password_envelope_for_storage(input)? {
            PasswordEnvelopeStorageFields::Current {
                wire_version,
                suite_id,
                vault_commitment,
            } => Ok(PasswordEnvelopeStorageDispositionV1::Current(
                PasswordEnvelopeStorageInspectionV1 {
                    wire_version,
                    suite_id,
                    vault_commitment,
                    envelope: input,
                },
            )),
            PasswordEnvelopeStorageFields::UnsupportedSuite {
                wire_version,
                suite_id,
            } => Ok(PasswordEnvelopeStorageDispositionV1::UnsupportedSuite(
                CurrentSuiteStorageInspectionV1 {
                    wire_version,
                    suite_id,
                    envelope: input.to_vec(),
                },
            )),
        },
        _ => unreachable!("wire versions are unsigned"),
    }
}

/// Classify a record envelope for bounded, session-free storage handling.
pub fn inspect_record_envelope_for_storage_v1(
    input: &[u8],
) -> Result<RecordEnvelopeStorageDispositionV1<'_>, CryptoError> {
    match inspect_outer_wire_version(input)? {
        version if version > CURRENT_WIRE_VERSION => Ok(
            RecordEnvelopeStorageDispositionV1::FutureWire(FutureWireStorageInspectionV1 {
                wire_version: version,
                envelope: input.to_vec(),
            }),
        ),
        CURRENT_WIRE_VERSION => match decode_record_envelope_for_storage(input)? {
            RecordEnvelopeStorageFields::Current {
                wire_version,
                suite_id,
                vault_commitment,
                record_id,
                revision_id,
                key_epoch,
                padding_bucket,
            } => Ok(RecordEnvelopeStorageDispositionV1::Current(
                RecordEnvelopeStorageInspectionV1 {
                    wire_version,
                    suite_id,
                    vault_commitment,
                    record_id,
                    revision_id,
                    key_epoch,
                    padding_bucket,
                    envelope: input,
                },
            )),
            RecordEnvelopeStorageFields::UnsupportedSuite {
                wire_version,
                suite_id,
            } => Ok(RecordEnvelopeStorageDispositionV1::UnsupportedSuite(
                CurrentSuiteStorageInspectionV1 {
                    wire_version,
                    suite_id,
                    envelope: input.to_vec(),
                },
            )),
        },
        _ => unreachable!("wire versions are unsigned"),
    }
}

impl PasswordEnvelopeStorageInspectionV1<'_> {
    pub const fn wire_version(&self) -> u32 {
        self.wire_version
    }

    pub const fn suite_id(&self) -> u32 {
        self.suite_id
    }

    pub const fn vault_commitment(&self) -> &[u8; 32] {
        self.vault_commitment.as_bytes()
    }

    pub const fn envelope(&self) -> &[u8] {
        self.envelope
    }

    pub fn bootstrap_projection(&self) -> PasswordEnvelopeBootstrapProjectionV1<'_> {
        PasswordEnvelopeBootstrapProjectionV1 {
            wire_version: self.wire_version,
            suite_id: self.suite_id,
            vault_commitment: *self.vault_commitment.as_bytes(),
            envelope: self.envelope,
        }
    }
}

impl RecordEnvelopeStorageInspectionV1<'_> {
    pub const fn wire_version(&self) -> u32 {
        self.wire_version
    }

    pub const fn suite_id(&self) -> u32 {
        self.suite_id
    }

    pub const fn vault_commitment(&self) -> &[u8; 32] {
        self.vault_commitment.as_bytes()
    }

    pub const fn record_id(&self) -> &[u8; 16] {
        self.record_id.as_bytes()
    }

    pub const fn revision_id(&self) -> &[u8; 32] {
        self.revision_id.as_bytes()
    }

    pub const fn key_epoch(&self) -> u32 {
        self.key_epoch.get()
    }

    pub const fn padding_bucket_bytes(&self) -> usize {
        self.padding_bucket.byte_len()
    }

    pub const fn envelope(&self) -> &[u8] {
        self.envelope
    }
}

impl PasswordEnvelopeBootstrapProjectionV1<'_> {
    pub const fn wire_version(&self) -> u32 {
        self.wire_version
    }

    pub const fn suite_id(&self) -> u32 {
        self.suite_id
    }

    pub const fn vault_commitment(&self) -> &[u8; 32] {
        &self.vault_commitment
    }

    pub const fn envelope(&self) -> &[u8] {
        self.envelope
    }
}

impl FutureWireStorageInspectionV1 {
    pub const fn wire_version(&self) -> u32 {
        self.wire_version
    }

    pub fn envelope(&self) -> &[u8] {
        self.envelope.as_slice()
    }
}

impl CurrentSuiteStorageInspectionV1 {
    pub const fn wire_version(&self) -> u32 {
        self.wire_version
    }

    pub const fn suite_id(&self) -> u32 {
        self.suite_id
    }

    pub fn envelope(&self) -> &[u8] {
        self.envelope.as_slice()
    }
}

fn inspect_outer_wire_version(input: &[u8]) -> Result<u32, CryptoError> {
    if input.is_empty() {
        return Err(CryptoError::NonCanonicalEncoding);
    }
    if input.len() > MAX_ENVELOPE_BYTES {
        return Err(CryptoError::LimitsExceeded);
    }

    let mut decoder = Decoder::new(input);
    let Some(field_count) = decoder
        .array()
        .map_err(|_| CryptoError::NonCanonicalEncoding)?
    else {
        return Err(CryptoError::NonCanonicalEncoding);
    };
    if field_count == 0 {
        return Err(CryptoError::NonCanonicalEncoding);
    }

    let version_start = decoder.position();
    let wire_version = decoder
        .u64()
        .map_err(|_| CryptoError::NonCanonicalEncoding)?;
    let version_end = decoder.position();
    let mut encoder = Encoder::new(Vec::new());
    encoder
        .u64(wire_version)
        .map_err(|_| CryptoError::NonCanonicalEncoding)?;
    if input.get(version_start..version_end) != Some(encoder.into_writer().as_slice()) {
        return Err(CryptoError::NonCanonicalEncoding);
    }

    u32::try_from(wire_version).map_err(|_| CryptoError::LimitsExceeded)
}
