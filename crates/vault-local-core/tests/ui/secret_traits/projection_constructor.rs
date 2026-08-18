use vault_crypto::VaultSession;
use vault_local_core::{
    AuthenticatedStoredCredentialRevisionV1, CredentialCommitPersistenceProjectionV1,
    CredentialStorageAuthenticatorV1, RecordIdV1, RevisionIdV1,
    SealedCredentialRecordV0Alpha1, StoredPaddingBucketV0Alpha1,
};

fn forge_boundary(
    session: &VaultSession,
    sealed: &SealedCredentialRecordV0Alpha1,
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
) {
    let bytes = [0_u8; 32];
    let envelope = [0_u8; 1];
    let _ = CredentialCommitPersistenceProjectionV1 {
        vault_commitment: &bytes,
        record_id,
        revision_id,
        expected_revision_id: None,
        wire_version: 0,
        suite_id: 0xA101,
        key_epoch: 1,
        padding_bucket: StoredPaddingBucketV0Alpha1::Bytes1024,
        envelope: &envelope,
    };
    let _ = CredentialStorageAuthenticatorV1 { session };
    let _ = AuthenticatedStoredCredentialRevisionV1 {
        envelope: &envelope,
        record_id,
        revision_id,
        parent_revision_id: None,
        key_epoch: 1,
        padding_bucket: StoredPaddingBucketV0Alpha1::Bytes1024,
    };
    let _ = sealed;
}

fn main() {}
