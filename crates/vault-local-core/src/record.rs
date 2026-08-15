use vault_crypto::{
    CryptoError, CryptoErrorCode, KeyEpoch, OpaqueRecordId, PaddingBucketV0Alpha1,
    RecordContextV0Alpha1, RevisionId, VaultSession, open_record_v0alpha1, seal_record_v0alpha1,
};

use crate::LocalVaultError;
#[cfg(test)]
use crate::codec::encode_synthetic_future_item_v2;
use crate::codec::{DecodedItem, decode_item, encode_current_item};
use crate::ids::{RecordIdV1, RevisionIdV1, generate_record_identity};
use crate::model::{ConsumerTypeV1, CredentialItemV1};
use crate::synthetic::{SyntheticCredentialFixtureId, build_synthetic_fixture_v1};

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum StoredPaddingBucketV0Alpha1 {
    Bytes1024,
    Bytes4096,
    Bytes16384,
    Bytes61440,
}

pub struct RecordLocatorV0Alpha1 {
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
    key_epoch: u32,
    padding_bucket: StoredPaddingBucketV0Alpha1,
}

pub struct SealedCredentialRecordV0Alpha1 {
    locator: RecordLocatorV0Alpha1,
    envelope: Vec<u8>,
}

pub struct OpenedCredentialV1 {
    item: CredentialItemV1,
}

#[allow(
    clippy::large_enum_variant,
    reason = "the required public boundary returns the owned opened item without indirection"
)]
pub enum OpenCredentialOutcome {
    Current(OpenedCredentialV1),
    UpgradeRequired,
}

impl OpenedCredentialV1 {
    pub fn item_name(&self) -> &str {
        &self.item.item_name
    }

    pub fn provider_name(&self) -> &str {
        &self.item.provider_name
    }

    pub fn connection_count(&self) -> usize {
        self.item.connections.len()
    }

    pub fn secret_field_count(&self) -> usize {
        self.item.secret_fields.len()
    }

    pub fn has_mcp_connection(&self) -> bool {
        self.item
            .connections
            .iter()
            .any(|connection| connection.consumer_type == ConsumerTypeV1::McpServer)
    }
}

pub fn seal_synthetic_fixture_v1(
    session: &VaultSession,
    fixture: SyntheticCredentialFixtureId,
) -> Result<SealedCredentialRecordV0Alpha1, LocalVaultError> {
    let item = build_synthetic_fixture_v1(fixture)?;
    let identity = generate_record_identity()?;
    item.validate(identity.revision_id)?;
    let plaintext = encode_current_item(&item, identity.revision_id)?;
    let padding_bucket = select_bucket(plaintext.expose_secret().len())?;
    let context = record_context(
        session,
        identity.record_id,
        identity.revision_id,
        session.key_epoch().get(),
        padding_bucket,
    )?;
    let envelope = seal_record_v0alpha1(session, &context, &plaintext).map_err(map_crypto_error)?;

    Ok(SealedCredentialRecordV0Alpha1 {
        locator: RecordLocatorV0Alpha1 {
            record_id: identity.record_id,
            revision_id: identity.revision_id,
            key_epoch: session.key_epoch().get(),
            padding_bucket,
        },
        envelope,
    })
}

pub fn open_credential_record_v1(
    session: &VaultSession,
    record: &SealedCredentialRecordV0Alpha1,
) -> Result<OpenCredentialOutcome, LocalVaultError> {
    let context = record_context(
        session,
        record.locator.record_id,
        record.locator.revision_id,
        record.locator.key_epoch,
        record.locator.padding_bucket,
    )?;
    let plaintext = match open_record_v0alpha1(session, &context, &record.envelope) {
        Ok(plaintext) => plaintext,
        Err(error) if error.code() == CryptoErrorCode::UnsupportedVersion => {
            return Ok(OpenCredentialOutcome::UpgradeRequired);
        }
        Err(error) => return Err(map_crypto_error(error)),
    };

    match decode_item(&plaintext, record.locator.revision_id)? {
        DecodedItem::Current(item) => {
            Ok(OpenCredentialOutcome::Current(OpenedCredentialV1 { item }))
        }
        DecodedItem::UpgradeRequired { version: _ } => Ok(OpenCredentialOutcome::UpgradeRequired),
    }
}

fn record_context(
    session: &VaultSession,
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
    key_epoch: u32,
    padding_bucket: StoredPaddingBucketV0Alpha1,
) -> Result<RecordContextV0Alpha1, LocalVaultError> {
    let key_epoch = KeyEpoch::new(key_epoch).map_err(map_crypto_error)?;
    Ok(RecordContextV0Alpha1::new(
        session.commitment(),
        OpaqueRecordId::from_bytes(*record_id.as_bytes()),
        RevisionId::from_bytes(*revision_id.as_bytes()),
        key_epoch,
        padding_bucket.into_crypto(),
    ))
}

fn map_crypto_error(error: CryptoError) -> LocalVaultError {
    match error.code() {
        CryptoErrorCode::AuthenticationFailed => LocalVaultError::AuthenticationFailed,
        CryptoErrorCode::RngUnavailable => LocalVaultError::RngUnavailable,
        CryptoErrorCode::LimitsExceeded => LocalVaultError::LimitsExceeded,
        CryptoErrorCode::UnsupportedVersion
        | CryptoErrorCode::UnsupportedSuite
        | CryptoErrorCode::NonCanonicalEncoding
        | CryptoErrorCode::InvalidLength
        | CryptoErrorCode::KdfParamsRejected => LocalVaultError::CryptoFailure,
    }
}

fn select_bucket(payload_len: usize) -> Result<StoredPaddingBucketV0Alpha1, LocalVaultError> {
    match payload_len {
        0..=1_020 => Ok(StoredPaddingBucketV0Alpha1::Bytes1024),
        1_021..=4_092 => Ok(StoredPaddingBucketV0Alpha1::Bytes4096),
        4_093..=16_380 => Ok(StoredPaddingBucketV0Alpha1::Bytes16384),
        16_381..=60_000 => Ok(StoredPaddingBucketV0Alpha1::Bytes61440),
        _ => Err(LocalVaultError::LimitsExceeded),
    }
}

impl StoredPaddingBucketV0Alpha1 {
    const fn into_crypto(self) -> PaddingBucketV0Alpha1 {
        match self {
            Self::Bytes1024 => PaddingBucketV0Alpha1::Bytes1024,
            Self::Bytes4096 => PaddingBucketV0Alpha1::Bytes4096,
            Self::Bytes16384 => PaddingBucketV0Alpha1::Bytes16384,
            Self::Bytes61440 => PaddingBucketV0Alpha1::Bytes61440,
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum SyntheticFutureVersion {
    InnerSchema2,
    OuterWire1,
}

#[cfg(test)]
pub(crate) fn open_synthetic_future_version_v1(
    session: &VaultSession,
    version: SyntheticFutureVersion,
) -> Result<(Vec<u8>, OpenCredentialOutcome, Vec<u8>), LocalVaultError> {
    let record = match version {
        SyntheticFutureVersion::InnerSchema2 => seal_synthetic_future_inner_v2(session)?,
        SyntheticFutureVersion::OuterWire1 => {
            let mut record = seal_synthetic_fixture_v1(
                session,
                SyntheticCredentialFixtureId::UnconnectedApiKey,
            )?;
            replace_outer_wire_version_with_one(&mut record.envelope)?;
            record
        }
    };

    let before = record.envelope.clone();
    let outcome = open_credential_record_v1(session, &record)?;
    let after = record.envelope.clone();
    Ok((before, outcome, after))
}

#[cfg(test)]
fn seal_synthetic_future_inner_v2(
    session: &VaultSession,
) -> Result<SealedCredentialRecordV0Alpha1, LocalVaultError> {
    let identity = generate_record_identity()?;
    let plaintext = encode_synthetic_future_item_v2()?;
    let padding_bucket = select_bucket(plaintext.expose_secret().len())?;
    let context = record_context(
        session,
        identity.record_id,
        identity.revision_id,
        session.key_epoch().get(),
        padding_bucket,
    )?;
    let envelope = seal_record_v0alpha1(session, &context, &plaintext).map_err(map_crypto_error)?;

    Ok(SealedCredentialRecordV0Alpha1 {
        locator: RecordLocatorV0Alpha1 {
            record_id: identity.record_id,
            revision_id: identity.revision_id,
            key_epoch: session.key_epoch().get(),
            padding_bucket,
        },
        envelope,
    })
}

#[cfg(test)]
fn replace_outer_wire_version_with_one(envelope: &mut [u8]) -> Result<(), LocalVaultError> {
    const RECORD_FIELD_COUNT: u64 = 12;

    let (version_start, version_end) = {
        let mut decoder = minicbor::Decoder::new(envelope);
        if decoder
            .array()
            .map_err(|_| LocalVaultError::CryptoFailure)?
            != Some(RECORD_FIELD_COUNT)
        {
            return Err(LocalVaultError::CryptoFailure);
        }
        let version_start = decoder.position();
        if decoder.u64().map_err(|_| LocalVaultError::CryptoFailure)? != 0 {
            return Err(LocalVaultError::CryptoFailure);
        }
        (version_start, decoder.position())
    };

    if version_end != version_start + 1 {
        return Err(LocalVaultError::CryptoFailure);
    }
    *envelope
        .get_mut(version_start)
        .ok_or(LocalVaultError::CryptoFailure)? = 1;
    Ok(())
}

#[cfg(test)]
pub(super) enum SyntheticRecordMutation {
    RecordId,
    RevisionId,
    KeyEpoch,
    PaddingBucket,
    Ciphertext,
}

#[cfg(test)]
fn synthetic_tamper_case_v1(
    session: &VaultSession,
    fixture: SyntheticCredentialFixtureId,
    mutation: SyntheticRecordMutation,
) -> Result<(), LocalVaultError> {
    let mut record = seal_synthetic_fixture_v1(session, fixture)?;
    match mutation {
        SyntheticRecordMutation::RecordId => {
            let mut bytes = *record.locator.record_id.as_bytes();
            bytes[0] ^= 1;
            record.locator.record_id = RecordIdV1::from_bytes(bytes);
        }
        SyntheticRecordMutation::RevisionId => {
            let mut bytes = *record.locator.revision_id.as_bytes();
            bytes[0] ^= 1;
            record.locator.revision_id = RevisionIdV1::from_bytes(bytes);
        }
        SyntheticRecordMutation::KeyEpoch => {
            record.locator.key_epoch = if record.locator.key_epoch == u32::MAX {
                1
            } else {
                record.locator.key_epoch + 1
            };
        }
        SyntheticRecordMutation::PaddingBucket => {
            record.locator.padding_bucket = match record.locator.padding_bucket {
                StoredPaddingBucketV0Alpha1::Bytes1024 => StoredPaddingBucketV0Alpha1::Bytes4096,
                StoredPaddingBucketV0Alpha1::Bytes4096
                | StoredPaddingBucketV0Alpha1::Bytes16384
                | StoredPaddingBucketV0Alpha1::Bytes61440 => StoredPaddingBucketV0Alpha1::Bytes1024,
            };
        }
        SyntheticRecordMutation::Ciphertext => {
            let last = record
                .envelope
                .last_mut()
                .ok_or(LocalVaultError::CryptoFailure)?;
            *last ^= 1;
        }
    }

    open_credential_record_v1(session, &record).map(|_| ())
}

#[cfg(test)]
#[path = "record_tests.rs"]
mod tests;
