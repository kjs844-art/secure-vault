use vault_crypto::{MasterPassword, create_vault_v0alpha1};

use super::{
    StoredPaddingBucketV0Alpha1, SyntheticRecordMutation, open_credential_record_v1,
    seal_synthetic_fixture_v1, select_bucket, synthetic_tamper_case_v1,
};
use crate::{LocalVaultError, LocalVaultErrorCode, SyntheticCredentialFixtureId};

fn expect_local_error_code<T>(result: Result<T, LocalVaultError>) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("an invalid synthetic record case was unexpectedly accepted"),
        Err(error) => error.code(),
    }
}

#[test]
fn product_payload_boundaries_select_the_smallest_bucket() {
    assert!(matches!(
        select_bucket(1_020).unwrap(),
        StoredPaddingBucketV0Alpha1::Bytes1024
    ));
    assert!(matches!(
        select_bucket(1_021).unwrap(),
        StoredPaddingBucketV0Alpha1::Bytes4096
    ));
    assert!(matches!(
        select_bucket(4_092).unwrap(),
        StoredPaddingBucketV0Alpha1::Bytes4096
    ));
    assert!(matches!(
        select_bucket(4_093).unwrap(),
        StoredPaddingBucketV0Alpha1::Bytes16384
    ));
    assert!(matches!(
        select_bucket(16_380).unwrap(),
        StoredPaddingBucketV0Alpha1::Bytes16384
    ));
    assert!(matches!(
        select_bucket(16_381).unwrap(),
        StoredPaddingBucketV0Alpha1::Bytes61440
    ));
    assert!(matches!(
        select_bucket(60_000).unwrap(),
        StoredPaddingBucketV0Alpha1::Bytes61440
    ));
    assert_eq!(
        expect_local_error_code(select_bucket(60_001)),
        LocalVaultErrorCode::LimitsExceeded,
    );
}

#[test]
fn locator_and_ciphertext_mutations_are_rejected() {
    let password = MasterPassword::from_utf8("synthetic tamper phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    for mutation in [
        SyntheticRecordMutation::RecordId,
        SyntheticRecordMutation::RevisionId,
        SyntheticRecordMutation::KeyEpoch,
        SyntheticRecordMutation::PaddingBucket,
        SyntheticRecordMutation::Ciphertext,
    ] {
        assert_eq!(
            synthetic_tamper_case_v1(
                &created.session,
                SyntheticCredentialFixtureId::SingleMcpConnection,
                mutation,
            )
            .unwrap_err()
            .code(),
            LocalVaultErrorCode::AuthenticationFailed
        );
    }
}

#[test]
fn another_vault_is_rejected_without_modifying_the_envelope() {
    let password = MasterPassword::from_utf8("synthetic tamper phrase".to_owned()).unwrap();
    let first = create_vault_v0alpha1(&password).unwrap();
    let second = create_vault_v0alpha1(&password).unwrap();
    let record = seal_synthetic_fixture_v1(
        &first.session,
        SyntheticCredentialFixtureId::SingleMcpConnection,
    )
    .unwrap();
    let envelope_before = record.envelope.clone();

    assert_eq!(
        expect_local_error_code(open_credential_record_v1(&second.session, &record)),
        LocalVaultErrorCode::AuthenticationFailed,
    );
    assert_eq!(record.envelope, envelope_before);
}
