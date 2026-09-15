use vault_crypto::{
    CryptoError, CryptoErrorCode, KeyEpoch, MasterPassword, OpaqueRecordId, PaddingBucketV0Alpha1,
    RecordContextV0Alpha1, RevisionId, SecretBytes, create_vault_v0alpha1, open_record_v0alpha1,
    seal_record_v0alpha1,
};

fn synthetic_password() -> MasterPassword {
    MasterPassword::from_utf8("synthetic epoch binding phrase".to_owned()).unwrap()
}

fn expect_crypto_error_code<T>(result: Result<T, CryptoError>) -> CryptoErrorCode {
    match result {
        Ok(_) => panic!("an invalid synthetic epoch case was unexpectedly accepted"),
        Err(error) => error.code(),
    }
}

#[test]
fn initial_password_session_is_epoch_one() {
    let created = create_vault_v0alpha1(&synthetic_password()).unwrap();
    assert_eq!(created.session.key_epoch().get(), 1);
}

#[test]
fn seal_and_open_reject_a_context_from_another_epoch() {
    let created = create_vault_v0alpha1(&synthetic_password()).unwrap();
    let wrong_epoch = RecordContextV0Alpha1::new(
        created.session.commitment(),
        OpaqueRecordId::from_bytes([0x11; 16]),
        RevisionId::from_bytes([0x22; 32]),
        KeyEpoch::new(2).unwrap(),
        PaddingBucketV0Alpha1::Bytes1024,
    );
    let payload = SecretBytes::new(b"DEMO_VALUE_ONLY_EPOCH".to_vec()).unwrap();

    assert_eq!(
        expect_crypto_error_code(seal_record_v0alpha1(
            &created.session,
            &wrong_epoch,
            &payload
        )),
        CryptoErrorCode::AuthenticationFailed,
    );

    let right_epoch = RecordContextV0Alpha1::new(
        created.session.commitment(),
        OpaqueRecordId::from_bytes([0x11; 16]),
        RevisionId::from_bytes([0x22; 32]),
        KeyEpoch::initial(),
        PaddingBucketV0Alpha1::Bytes1024,
    );
    let envelope = seal_record_v0alpha1(&created.session, &right_epoch, &payload).unwrap();
    assert_eq!(
        expect_crypto_error_code(open_record_v0alpha1(
            &created.session,
            &wrong_epoch,
            &envelope
        )),
        CryptoErrorCode::AuthenticationFailed,
    );
}

#[test]
fn key_epoch_cannot_wrap_past_u32_max() {
    assert_eq!(
        expect_crypto_error_code(KeyEpoch::new(u32::MAX).unwrap().checked_next()),
        CryptoErrorCode::LimitsExceeded,
    );
}
