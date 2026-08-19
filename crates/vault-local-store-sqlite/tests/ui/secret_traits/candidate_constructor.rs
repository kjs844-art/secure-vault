use vault_local_core::{
    CredentialCommitPersistenceProjectionV1, RecordIdV1, RevisionIdV1,
    StoredPaddingBucketV0Alpha1,
};

#[allow(clippy::too_many_arguments)]
fn cannot_construct_candidate(
    vault_commitment: &'static [u8; 32],
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
    expected_revision_id: Option<RevisionIdV1>,
    wire_version: u32,
    suite_id: u32,
    key_epoch: u32,
    padding_bucket: StoredPaddingBucketV0Alpha1,
    envelope: &'static [u8],
) {
    let _ = CredentialCommitPersistenceProjectionV1 {
        vault_commitment,
        record_id,
        revision_id,
        expected_revision_id,
        wire_version,
        suite_id,
        key_epoch,
        padding_bucket,
        envelope,
    };
}

fn main() {}
