use vault_crypto::{MasterPassword, create_vault_v0alpha1};
use vault_local_core::{
    CredentialStorageAuthenticatorV1, OpenCredentialOutcome, OwnedRehydratedCredentialOutcomeV1,
    StoredCredentialAuthenticationOutcomeV1, SyntheticCredentialFixtureId,
    create_synthetic_successor_v1, open_credential_record_v1, seal_synthetic_fixture_v1,
};

#[test]
fn sealed_fixture_projects_and_rehydrates_without_caller_locator_fields() {
    let password =
        MasterPassword::from_utf8("synthetic persistence boundary phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let sealed = seal_synthetic_fixture_v1(
        &created.session,
        SyntheticCredentialFixtureId::SingleMcpConnection,
    )
    .unwrap();

    let projection = sealed.persistence_projection_v1();
    let stored_columns = (
        *projection.vault_commitment(),
        projection.record_id(),
        projection.revision_id(),
        projection.expected_revision_id(),
        projection.wire_version(),
        projection.suite_id(),
        projection.key_epoch(),
        projection.padding_bucket(),
    );
    let stored_envelope = projection.envelope().to_vec();
    assert!(stored_columns.3.is_none());
    let mut untrusted_cache_columns = (
        stored_columns.0,
        *stored_columns.1.as_bytes(),
        *stored_columns.2.as_bytes(),
        stored_columns.6,
        stored_columns.7,
    );
    untrusted_cache_columns.0[0] ^= 1;
    untrusted_cache_columns.1[0] ^= 1;
    untrusted_cache_columns.2[0] ^= 1;
    untrusted_cache_columns.3 += 1;
    untrusted_cache_columns.4 = match untrusted_cache_columns.4 {
        vault_local_core::StoredPaddingBucketV0Alpha1::Bytes1024 => {
            vault_local_core::StoredPaddingBucketV0Alpha1::Bytes4096
        }
        _ => vault_local_core::StoredPaddingBucketV0Alpha1::Bytes1024,
    };
    assert_ne!(untrusted_cache_columns.0, stored_columns.0);
    assert_ne!(untrusted_cache_columns.1, *stored_columns.1.as_bytes());
    assert_ne!(untrusted_cache_columns.2, *stored_columns.2.as_bytes());
    assert_ne!(untrusted_cache_columns.3, stored_columns.6);
    assert!(untrusted_cache_columns.4 != stored_columns.7);
    drop(sealed);

    let authenticator = CredentialStorageAuthenticatorV1::new(&created.session);
    let receipt = authenticator
        .authenticate_stored_credential_v1(&stored_envelope)
        .unwrap();
    let StoredCredentialAuthenticationOutcomeV1::Current(receipt) = receipt else {
        panic!("current synthetic credential unexpectedly requires upgrade");
    };
    assert_eq!(receipt.envelope(), stored_envelope.as_slice());
    assert_eq!(receipt.envelope().len(), stored_envelope.len());
    assert!(std::ptr::eq(
        receipt.envelope().as_ptr(),
        stored_envelope.as_ptr()
    ));
    assert!(receipt.record_id() == stored_columns.1);
    assert!(receipt.revision_id() == stored_columns.2);
    assert!(receipt.parent_revision_id().is_none());
    assert_eq!(receipt.key_epoch(), stored_columns.6);
    assert!(receipt.padding_bucket() == stored_columns.7);
    let rehydrated = authenticator
        .rehydrate_owned_stored_credential_v1(stored_envelope)
        .unwrap();
    let OwnedRehydratedCredentialOutcomeV1::Current(rehydrated) = rehydrated else {
        panic!("current synthetic credential unexpectedly requires upgrade");
    };
    let OpenCredentialOutcome::Current(opened) =
        open_credential_record_v1(&created.session, rehydrated.sealed_record()).unwrap()
    else {
        panic!("rehydrated current credential unexpectedly requires upgrade");
    };
    assert_eq!(opened.provider_name(), "Example AI Workshop");
    assert_eq!(opened.connection_count(), 1);
}

#[test]
fn two_successors_keep_the_record_id_and_receive_distinct_csprng_revisions() {
    let password =
        MasterPassword::from_utf8("synthetic sibling successor phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let predecessor = seal_synthetic_fixture_v1(
        &created.session,
        SyntheticCredentialFixtureId::SingleMcpConnection,
    )
    .unwrap();
    let predecessor_projection = predecessor.persistence_projection_v1();
    let record_id = predecessor_projection.record_id();
    let predecessor_revision = predecessor_projection.revision_id();
    let first = create_synthetic_successor_v1(&created.session, &predecessor).unwrap();
    let second = create_synthetic_successor_v1(&created.session, &predecessor).unwrap();
    let first_projection = first.persistence_projection_v1();
    let second_projection = second.persistence_projection_v1();

    assert!(first_projection.record_id() == record_id);
    assert!(second_projection.record_id() == record_id);
    assert!(first_projection.revision_id() != second_projection.revision_id());
    assert!(first_projection.expected_revision_id() == Some(predecessor_revision));
    assert!(second_projection.expected_revision_id() == Some(predecessor_revision));
}

#[test]
fn cross_vault_rehydrate_fails_without_mutating_the_envelope() {
    let first_password =
        MasterPassword::from_utf8("synthetic source vault phrase".to_owned()).unwrap();
    let second_password =
        MasterPassword::from_utf8("synthetic destination vault phrase".to_owned()).unwrap();
    let first = create_vault_v0alpha1(&first_password).unwrap();
    let second = create_vault_v0alpha1(&second_password).unwrap();
    let record = seal_synthetic_fixture_v1(
        &first.session,
        SyntheticCredentialFixtureId::UnconnectedApiKey,
    )
    .unwrap();
    let envelope = record.persistence_projection_v1().envelope().to_vec();
    let before = envelope.clone();

    let authenticator = CredentialStorageAuthenticatorV1::new(&second.session);
    assert!(
        authenticator
            .authenticate_stored_credential_v1(&envelope)
            .is_err()
    );
    assert_eq!(envelope, before);
}
