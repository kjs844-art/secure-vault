use vault_crypto::{
    CryptoErrorCode, KeyEpoch, MasterPassword, OpaqueRecordId, PaddingBucketV0Alpha1,
    RecordContextV0Alpha1, RevisionId, create_vault_v0alpha1,
    inspect_password_envelope_for_storage_v1, inspect_record_envelope_for_storage_v1,
    seal_record_v0alpha1,
};

fn error_code<T>(result: Result<T, vault_crypto::CryptoError>) -> CryptoErrorCode {
    match result {
        Ok(_) => panic!("malformed envelope was accepted"),
        Err(error) => error.code(),
    }
}

#[test]
fn current_password_and_record_metadata_are_derived_from_canonical_envelopes() {
    let password =
        MasterPassword::from_utf8("synthetic storage inspection password".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let record_id = OpaqueRecordId::from_bytes([0x31; 16]);
    let revision_id = RevisionId::from_bytes([0x42; 32]);
    let context = RecordContextV0Alpha1::new(
        created.session.commitment(),
        record_id.clone(),
        revision_id.clone(),
        KeyEpoch::new(1).unwrap(),
        PaddingBucketV0Alpha1::Bytes1024,
    );
    let record_envelope = seal_record_v0alpha1(
        &created.session,
        &context,
        &vault_crypto::SecretBytes::new(b"synthetic record body".to_vec()).unwrap(),
    )
    .unwrap();

    let password_inspection =
        match inspect_password_envelope_for_storage_v1(&created.password_envelope).unwrap() {
            vault_crypto::PasswordEnvelopeStorageDispositionV1::Current(inspection) => inspection,
            _ => panic!("a canonical current password envelope was not current"),
        };
    let record_inspection = match inspect_record_envelope_for_storage_v1(&record_envelope).unwrap()
    {
        vault_crypto::RecordEnvelopeStorageDispositionV1::Current(inspection) => inspection,
        _ => panic!("a canonical current record envelope was not current"),
    };

    assert_eq!(password_inspection.wire_version(), 0);
    assert_eq!(password_inspection.suite_id(), 0xA101);
    assert_eq!(record_inspection.wire_version(), 0);
    assert_eq!(record_inspection.suite_id(), 0xA101);
    assert_eq!(
        password_inspection.vault_commitment(),
        record_inspection.vault_commitment()
    );
    assert_eq!(record_inspection.record_id(), &[0x31; 16]);
    assert_eq!(record_inspection.revision_id(), &[0x42; 32]);
    assert_eq!(record_inspection.key_epoch(), 1);
    assert_eq!(record_inspection.padding_bucket_bytes(), 1_024);
    assert_eq!(
        password_inspection.envelope(),
        created.password_envelope.as_slice()
    );
    assert_eq!(record_inspection.envelope(), record_envelope.as_slice());

    let bootstrap = password_inspection.bootstrap_projection();
    assert_eq!(bootstrap.wire_version(), 0);
    assert_eq!(bootstrap.suite_id(), 0xA101);
    assert_eq!(
        bootstrap.vault_commitment(),
        password_inspection.vault_commitment()
    );
    assert_eq!(bootstrap.envelope(), created.password_envelope.as_slice());
}

#[test]
fn future_first_version_with_changed_field_count_and_unknown_tail_is_preserved() {
    let future_password = [0x81, 0x01];
    let future_record = [0x83, 0x02, 0x42, 0x01, 0x02, 0x18, 0x2a];

    let password_disposition = inspect_password_envelope_for_storage_v1(&future_password).unwrap();
    let record_disposition = inspect_record_envelope_for_storage_v1(&future_record).unwrap();

    match password_disposition {
        vault_crypto::PasswordEnvelopeStorageDispositionV1::FutureWire(inspection) => {
            assert_eq!(inspection.wire_version(), 1);
            assert_eq!(inspection.envelope(), future_password.as_slice());
        }
        _ => panic!("future password envelope was not preserved"),
    }
    match record_disposition {
        vault_crypto::RecordEnvelopeStorageDispositionV1::FutureWire(inspection) => {
            assert_eq!(inspection.wire_version(), 2);
            assert_eq!(inspection.envelope(), future_record.as_slice());
        }
        _ => panic!("future record envelope was not preserved"),
    }
}

#[test]
fn empty_indefinite_nonminimal_trailing_and_oversized_inputs_are_rejected() {
    for malformed in [
        Vec::new(),
        vec![0x80],
        vec![0x9f, 0xff],
        vec![0x81, 0x18, 0x01],
    ] {
        assert_eq!(
            error_code(inspect_password_envelope_for_storage_v1(&malformed)),
            CryptoErrorCode::NonCanonicalEncoding
        );
    }

    let password =
        MasterPassword::from_utf8("synthetic malformed inspection password".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let mut trailing = created.password_envelope.clone();
    trailing.push(0);
    assert_eq!(
        error_code(inspect_password_envelope_for_storage_v1(&trailing)),
        CryptoErrorCode::NonCanonicalEncoding
    );

    let mut unknown_suite = created.password_envelope.clone();
    unknown_suite[4] = 0x02;
    assert!(matches!(
        inspect_password_envelope_for_storage_v1(&unknown_suite).unwrap(),
        vault_crypto::PasswordEnvelopeStorageDispositionV1::UnsupportedSuite(_)
    ));

    let mut malformed_unknown_suite = unknown_suite;
    malformed_unknown_suite.splice(1..2, [0x18, 0x00]);
    assert_eq!(
        error_code(inspect_password_envelope_for_storage_v1(
            &malformed_unknown_suite
        )),
        CryptoErrorCode::NonCanonicalEncoding
    );

    assert_eq!(
        error_code(inspect_record_envelope_for_storage_v1(&vec![0; 65_537])),
        CryptoErrorCode::LimitsExceeded
    );
}
