use vault_crypto::{
    RecordEnvelopeStorageDispositionV1, VaultCommitment, VaultSession,
    inspect_record_envelope_for_storage_v1, open_record_v0alpha1, seal_record_v0alpha1,
};

use crate::LocalVaultError;
use crate::codec::{DecodedItem, decode_item, encode_current_item};
use crate::ids::{RecordIdV1, RevisionIdV1};
use crate::model::CredentialItemV1;
use crate::record::{
    SealedCredentialRecordV0Alpha1, StoredPaddingBucketV0Alpha1, map_crypto_error, record_context,
    sealed_from_current_envelope, select_bucket,
};

const CURRENT_WIRE_VERSION: u32 = 0;
const CURRENT_SUITE_ID: u32 = 0xA101;

pub struct CredentialCommitPersistenceProjectionV1<'a> {
    vault_commitment: &'a [u8; 32],
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
    expected_revision_id: Option<RevisionIdV1>,
    wire_version: u32,
    suite_id: u32,
    key_epoch: u32,
    padding_bucket: StoredPaddingBucketV0Alpha1,
    envelope: &'a [u8],
}

pub struct CredentialStorageAuthenticatorV1<'session> {
    session: &'session VaultSession,
}

pub enum StoredCredentialAuthenticationOutcomeV1<'a> {
    Current(AuthenticatedStoredCredentialRevisionV1<'a>),
    AuthenticatedFutureInner(PreservedStoredCredentialEnvelopeV1<'a>),
}

pub struct AuthenticatedStoredCredentialRevisionV1<'a> {
    envelope: &'a [u8],
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
    parent_revision_id: Option<RevisionIdV1>,
    key_epoch: u32,
    padding_bucket: StoredPaddingBucketV0Alpha1,
}

pub struct PreservedStoredCredentialEnvelopeV1<'a> {
    envelope: &'a [u8],
}

pub struct SyntheticCredentialSuccessorV1 {
    sealed: SealedCredentialRecordV0Alpha1,
    expected_revision_id: RevisionIdV1,
}

pub enum OwnedRehydratedCredentialOutcomeV1 {
    Current(OwnedRehydratedCredentialV1),
    UpgradeRequired(OwnedPreservedCredentialEnvelopeV1),
}

pub struct OwnedRehydratedCredentialV1 {
    sealed: SealedCredentialRecordV0Alpha1,
}

pub struct OwnedPreservedCredentialEnvelopeV1 {
    envelope: Vec<u8>,
}

struct CurrentEnvelopeMetadata {
    vault_commitment: [u8; 32],
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
    key_epoch: u32,
    padding_bucket: StoredPaddingBucketV0Alpha1,
}

enum AuthenticatedItem {
    Current {
        metadata: CurrentEnvelopeMetadata,
        item: Box<CredentialItemV1>,
    },
    FutureInner,
}

impl CredentialCommitPersistenceProjectionV1<'_> {
    pub const fn vault_commitment(&self) -> &[u8; 32] {
        self.vault_commitment
    }

    pub const fn record_id(&self) -> RecordIdV1 {
        self.record_id
    }

    pub const fn revision_id(&self) -> RevisionIdV1 {
        self.revision_id
    }

    pub const fn expected_revision_id(&self) -> Option<RevisionIdV1> {
        self.expected_revision_id
    }

    pub const fn wire_version(&self) -> u32 {
        self.wire_version
    }

    pub const fn suite_id(&self) -> u32 {
        self.suite_id
    }

    pub const fn key_epoch(&self) -> u32 {
        self.key_epoch
    }

    pub const fn padding_bucket(&self) -> StoredPaddingBucketV0Alpha1 {
        self.padding_bucket
    }

    pub const fn envelope(&self) -> &[u8] {
        self.envelope
    }
}

impl SealedCredentialRecordV0Alpha1 {
    pub fn persistence_projection_v1(&self) -> CredentialCommitPersistenceProjectionV1<'_> {
        projection_from_closed_record(self, None)
    }
}

impl SyntheticCredentialSuccessorV1 {
    pub fn persistence_projection_v1(&self) -> CredentialCommitPersistenceProjectionV1<'_> {
        projection_from_closed_record(&self.sealed, Some(self.expected_revision_id))
    }
}

impl CredentialStorageAuthenticatorV1<'_> {
    pub const fn new(session: &VaultSession) -> CredentialStorageAuthenticatorV1<'_> {
        CredentialStorageAuthenticatorV1 { session }
    }

    pub fn vault_commitment(&self) -> VaultCommitment {
        self.session.commitment()
    }

    pub fn authenticate_stored_credential_v1<'a>(
        &self,
        envelope: &'a [u8],
    ) -> Result<StoredCredentialAuthenticationOutcomeV1<'a>, LocalVaultError> {
        match authenticate_current_envelope(self.session, envelope)? {
            AuthenticatedItem::Current { metadata, item } => {
                let parent_revision_id = item.parent_revision_id;
                drop(item);
                Ok(StoredCredentialAuthenticationOutcomeV1::Current(
                    AuthenticatedStoredCredentialRevisionV1 {
                        envelope,
                        record_id: metadata.record_id,
                        revision_id: metadata.revision_id,
                        parent_revision_id,
                        key_epoch: metadata.key_epoch,
                        padding_bucket: metadata.padding_bucket,
                    },
                ))
            }
            AuthenticatedItem::FutureInner => Ok(
                StoredCredentialAuthenticationOutcomeV1::AuthenticatedFutureInner(
                    PreservedStoredCredentialEnvelopeV1 { envelope },
                ),
            ),
        }
    }

    pub fn rehydrate_owned_stored_credential_v1(
        &self,
        envelope: Vec<u8>,
    ) -> Result<OwnedRehydratedCredentialOutcomeV1, LocalVaultError> {
        match inspect_record_envelope_for_storage_v1(&envelope).map_err(map_crypto_error)? {
            RecordEnvelopeStorageDispositionV1::FutureWire(_)
            | RecordEnvelopeStorageDispositionV1::UnsupportedSuite(_) => {
                return Ok(OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(
                    OwnedPreservedCredentialEnvelopeV1 { envelope },
                ));
            }
            RecordEnvelopeStorageDispositionV1::Current(_) => {}
        }

        match authenticate_current_envelope(self.session, &envelope)? {
            AuthenticatedItem::Current { item, .. } => {
                drop(item);
                let sealed = sealed_from_current_envelope(envelope)?;
                Ok(OwnedRehydratedCredentialOutcomeV1::Current(
                    OwnedRehydratedCredentialV1 { sealed },
                ))
            }
            AuthenticatedItem::FutureInner => {
                Ok(OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(
                    OwnedPreservedCredentialEnvelopeV1 { envelope },
                ))
            }
        }
    }
}

impl AuthenticatedStoredCredentialRevisionV1<'_> {
    pub const fn envelope(&self) -> &[u8] {
        self.envelope
    }

    pub const fn record_id(&self) -> RecordIdV1 {
        self.record_id
    }

    pub const fn revision_id(&self) -> RevisionIdV1 {
        self.revision_id
    }

    pub const fn parent_revision_id(&self) -> Option<RevisionIdV1> {
        self.parent_revision_id
    }

    pub const fn wire_version(&self) -> u32 {
        CURRENT_WIRE_VERSION
    }

    pub const fn suite_id(&self) -> u32 {
        CURRENT_SUITE_ID
    }

    pub const fn key_epoch(&self) -> u32 {
        self.key_epoch
    }

    pub const fn padding_bucket(&self) -> StoredPaddingBucketV0Alpha1 {
        self.padding_bucket
    }
}

impl PreservedStoredCredentialEnvelopeV1<'_> {
    pub const fn envelope(&self) -> &[u8] {
        self.envelope
    }
}

impl OwnedRehydratedCredentialV1 {
    pub const fn sealed_record(&self) -> &SealedCredentialRecordV0Alpha1 {
        &self.sealed
    }
}

impl OwnedPreservedCredentialEnvelopeV1 {
    pub fn envelope(&self) -> &[u8] {
        self.envelope.as_slice()
    }
}

pub fn create_synthetic_successor_v1(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
) -> Result<SyntheticCredentialSuccessorV1, LocalVaultError> {
    create_synthetic_successor_with_revision_fill(session, predecessor, |revision| {
        getrandom::fill(revision).map_err(|_| LocalVaultError::RngUnavailable)
    })
}

fn create_synthetic_successor_with_revision_fill(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
    fill_revision: impl FnOnce(&mut [u8; 32]) -> Result<(), LocalVaultError>,
) -> Result<SyntheticCredentialSuccessorV1, LocalVaultError> {
    create_synthetic_edited_successor_with_revision_fill(
        session,
        predecessor,
        |_, _| Ok(()),
        fill_revision,
    )
}

pub(crate) fn create_synthetic_edited_successor_v1(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
    edit: impl FnOnce(&mut CredentialItemV1) -> Result<(), LocalVaultError>,
) -> Result<SyntheticCredentialSuccessorV1, LocalVaultError> {
    create_synthetic_edited_successor_with_predecessor_v1(session, predecessor, |item, _| {
        edit(item)
    })
}

pub(crate) fn inspect_synthetic_predecessor_v1<T>(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
    inspect: impl FnOnce(&CredentialItemV1, RevisionIdV1) -> Result<T, LocalVaultError>,
) -> Result<T, LocalVaultError> {
    let AuthenticatedItem::Current { metadata, item } =
        authenticate_current_envelope(session, &predecessor.envelope)?
    else {
        return Err(LocalVaultError::CryptoFailure);
    };

    inspect(&item, metadata.revision_id)
}

pub(crate) fn create_synthetic_edited_successor_with_predecessor_v1(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
    edit: impl FnOnce(&mut CredentialItemV1, RevisionIdV1) -> Result<(), LocalVaultError>,
) -> Result<SyntheticCredentialSuccessorV1, LocalVaultError> {
    create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
        session,
        predecessor,
        edit,
        |revision| getrandom::fill(revision).map_err(|_| LocalVaultError::RngUnavailable),
    )
}

pub(crate) fn create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
    edit: impl FnOnce(&mut CredentialItemV1, RevisionIdV1) -> Result<(), LocalVaultError>,
    fill_revision: impl FnOnce(&mut [u8; 32]) -> Result<(), LocalVaultError>,
) -> Result<SyntheticCredentialSuccessorV1, LocalVaultError> {
    create_synthetic_edited_successor_with_revision_fill(session, predecessor, edit, fill_revision)
}

fn create_synthetic_edited_successor_with_revision_fill(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
    edit: impl FnOnce(&mut CredentialItemV1, RevisionIdV1) -> Result<(), LocalVaultError>,
    fill_revision: impl FnOnce(&mut [u8; 32]) -> Result<(), LocalVaultError>,
) -> Result<SyntheticCredentialSuccessorV1, LocalVaultError> {
    let AuthenticatedItem::Current { metadata, mut item } =
        authenticate_current_envelope(session, &predecessor.envelope)?
    else {
        return Err(LocalVaultError::CryptoFailure);
    };

    let expected_revision_id = metadata.revision_id;
    // A completed cutover event remains in its immutable predecessor. Reject
    // incomplete events before any edit or revision RNG can run. Apply this to
    // every successor, including the generic/no-op path.
    crate::rotation_lifecycle::prepare_rotation_successor_v1(&mut item)?;
    edit(&mut item, expected_revision_id)?;
    // The persistence boundary, not an edit closure, is authoritative for the
    // immutable revision chain linkage.
    item.parent_revision_id = Some(expected_revision_id);
    let mut revision_bytes = [0_u8; 32];
    fill_revision(&mut revision_bytes)?;
    let revision_id = RevisionIdV1::from_bytes(revision_bytes);
    let plaintext = encode_current_item(&item, revision_id)?;
    let padding_bucket = select_bucket(plaintext.expose_secret().len())?;
    let context = record_context(
        session,
        metadata.record_id,
        revision_id,
        session.key_epoch().get(),
        padding_bucket,
    )?;
    let envelope = seal_record_v0alpha1(session, &context, &plaintext).map_err(map_crypto_error)?;
    let sealed = sealed_from_current_envelope(envelope)?;

    Ok(SyntheticCredentialSuccessorV1 {
        sealed,
        expected_revision_id,
    })
}

fn projection_from_closed_record(
    record: &SealedCredentialRecordV0Alpha1,
    expected_revision_id: Option<RevisionIdV1>,
) -> CredentialCommitPersistenceProjectionV1<'_> {
    let Ok(metadata) = current_metadata_from_envelope(&record.envelope) else {
        unreachable!("closed current credential invariant");
    };
    debug_assert!(metadata.vault_commitment == record.vault_commitment);
    CredentialCommitPersistenceProjectionV1 {
        vault_commitment: &record.vault_commitment,
        record_id: metadata.record_id,
        revision_id: metadata.revision_id,
        expected_revision_id,
        wire_version: CURRENT_WIRE_VERSION,
        suite_id: CURRENT_SUITE_ID,
        key_epoch: metadata.key_epoch,
        padding_bucket: metadata.padding_bucket,
        envelope: &record.envelope,
    }
}

fn authenticate_current_envelope(
    session: &VaultSession,
    envelope: &[u8],
) -> Result<AuthenticatedItem, LocalVaultError> {
    let metadata = current_metadata_from_envelope(envelope)?;
    if VaultCommitment::from_bytes(metadata.vault_commitment) != session.commitment()
        || metadata.key_epoch != session.key_epoch().get()
    {
        return Err(LocalVaultError::AuthenticationFailed);
    }
    let context = record_context(
        session,
        metadata.record_id,
        metadata.revision_id,
        metadata.key_epoch,
        metadata.padding_bucket,
    )?;
    let plaintext = open_record_v0alpha1(session, &context, envelope).map_err(map_crypto_error)?;
    match decode_item(&plaintext, metadata.revision_id)? {
        DecodedItem::Current(item) => Ok(AuthenticatedItem::Current {
            metadata,
            item: Box::new(item),
        }),
        DecodedItem::UpgradeRequired { version: _ } => Ok(AuthenticatedItem::FutureInner),
    }
}

fn current_metadata_from_envelope(
    envelope: &[u8],
) -> Result<CurrentEnvelopeMetadata, LocalVaultError> {
    let inspection =
        match inspect_record_envelope_for_storage_v1(envelope).map_err(map_crypto_error)? {
            RecordEnvelopeStorageDispositionV1::Current(inspection) => inspection,
            RecordEnvelopeStorageDispositionV1::FutureWire(_)
            | RecordEnvelopeStorageDispositionV1::UnsupportedSuite(_) => {
                return Err(LocalVaultError::CryptoFailure);
            }
        };
    Ok(CurrentEnvelopeMetadata {
        vault_commitment: *inspection.vault_commitment(),
        record_id: RecordIdV1::from_bytes(*inspection.record_id()),
        revision_id: RevisionIdV1::from_bytes(*inspection.revision_id()),
        key_epoch: inspection.key_epoch(),
        padding_bucket: StoredPaddingBucketV0Alpha1::from_bytes(inspection.padding_bucket_bytes())?,
    })
}

#[cfg(test)]
mod tests {
    // Unit-only fixtures exercise entropy call shape and preservation outcomes.
    use vault_crypto::{MasterPassword, create_vault_v0alpha1};

    use super::*;
    use crate::record::seal_synthetic_future_inner_v2;
    use crate::{SyntheticCredentialFixtureId, seal_synthetic_fixture_v1};

    #[test]
    fn successor_revision_entropy_is_one_exact_thirty_two_byte_draw() {
        let password = MasterPassword::from_utf8(
            "synthetic deterministic successor entropy phrase".to_owned(),
        )
        .unwrap();
        let created = create_vault_v0alpha1(&password).unwrap();
        let predecessor = seal_synthetic_fixture_v1(
            &created.session,
            SyntheticCredentialFixtureId::UnconnectedApiKey,
        )
        .unwrap();
        let mut calls = 0;

        let successor = create_synthetic_successor_with_revision_fill(
            &created.session,
            &predecessor,
            |revision| {
                calls += 1;
                revision.fill(0x5a);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(calls, 1);
        assert_eq!(
            successor
                .persistence_projection_v1()
                .revision_id()
                .as_bytes(),
            &[0x5a; 32]
        );
    }

    #[test]
    fn authenticated_future_inner_and_unrecognized_outer_bytes_are_preserved_exactly() {
        let password =
            MasterPassword::from_utf8("synthetic future preservation phrase".to_owned()).unwrap();
        let created = create_vault_v0alpha1(&password).unwrap();
        let authenticator = CredentialStorageAuthenticatorV1::new(&created.session);
        let future_inner = seal_synthetic_future_inner_v2(&created.session).unwrap();
        let inner_bytes = future_inner.envelope.clone();

        let borrowed = authenticator
            .authenticate_stored_credential_v1(&inner_bytes)
            .unwrap();
        let StoredCredentialAuthenticationOutcomeV1::AuthenticatedFutureInner(preserved) = borrowed
        else {
            panic!("future inner credential was promoted to current");
        };
        assert_eq!(preserved.envelope(), inner_bytes.as_slice());
        assert!(std::ptr::eq(
            preserved.envelope().as_ptr(),
            inner_bytes.as_ptr()
        ));

        let owned = authenticator
            .rehydrate_owned_stored_credential_v1(inner_bytes.clone())
            .unwrap();
        let OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(preserved) = owned else {
            panic!("future inner credential was promoted to current");
        };
        assert_eq!(preserved.envelope(), inner_bytes.as_slice());

        let future_outer = vec![0x81, 0x01];
        let owned = authenticator
            .rehydrate_owned_stored_credential_v1(future_outer.clone())
            .unwrap();
        let OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(preserved) = owned else {
            panic!("future outer credential was promoted to current");
        };
        assert_eq!(preserved.envelope(), future_outer.as_slice());

        let current = seal_synthetic_fixture_v1(
            &created.session,
            SyntheticCredentialFixtureId::UnconnectedApiKey,
        )
        .unwrap();
        let mut unsupported_suite = current.envelope.clone();
        unsupported_suite[4] ^= 0x01;
        assert!(matches!(
            inspect_record_envelope_for_storage_v1(&unsupported_suite).unwrap(),
            RecordEnvelopeStorageDispositionV1::UnsupportedSuite(_)
        ));
        let owned = authenticator
            .rehydrate_owned_stored_credential_v1(unsupported_suite.clone())
            .unwrap();
        let OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(preserved) = owned else {
            panic!("unsupported suite credential was promoted to current");
        };
        assert_eq!(preserved.envelope(), unsupported_suite.as_slice());
    }

    #[test]
    fn projection_rederives_locator_fields_from_the_canonical_envelope() {
        let password =
            MasterPassword::from_utf8("synthetic projection authority phrase".to_owned()).unwrap();
        let created = create_vault_v0alpha1(&password).unwrap();
        let mut sealed = seal_synthetic_fixture_v1(
            &created.session,
            SyntheticCredentialFixtureId::UnconnectedApiKey,
        )
        .unwrap();
        let original = sealed.persistence_projection_v1();
        let record_id = original.record_id;
        let revision_id = original.revision_id;
        let key_epoch = original.key_epoch;
        let padding_bucket = original.padding_bucket;

        sealed.locator.record_id = RecordIdV1::from_bytes([0x11; 16]);
        sealed.locator.revision_id = RevisionIdV1::from_bytes([0x22; 32]);
        sealed.locator.key_epoch = key_epoch.saturating_add(1);
        sealed.locator.padding_bucket = match padding_bucket {
            StoredPaddingBucketV0Alpha1::Bytes1024 => StoredPaddingBucketV0Alpha1::Bytes4096,
            _ => StoredPaddingBucketV0Alpha1::Bytes1024,
        };

        let rederived = sealed.persistence_projection_v1();
        assert!(rederived.record_id == record_id);
        assert!(rederived.revision_id == revision_id);
        assert_eq!(rederived.key_epoch, key_epoch);
        assert!(rederived.padding_bucket == padding_bucket);
    }
}
