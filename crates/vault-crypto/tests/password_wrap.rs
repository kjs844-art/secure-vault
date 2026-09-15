use std::sync::{Mutex, MutexGuard};

use minicbor::{Decoder, Encoder};
use vault_crypto::{CryptoErrorCode, MasterPassword, create_vault_v0alpha1, unlock_vault_v0alpha1};

static KDF_TEST_LOCK: Mutex<()> = Mutex::new(());

struct PasswordEnvelopeFields {
    version: u64,
    suite: u64,
    kind: u64,
    salt: Vec<u8>,
    memory_kib: u64,
    time_cost: u64,
    lanes: u64,
    commitment: Vec<u8>,
    root_nonce: Vec<u8>,
    wrapped_root: Vec<u8>,
}

fn serial_kdf() -> MutexGuard<'static, ()> {
    KDF_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn decode_password_envelope(input: &[u8]) -> PasswordEnvelopeFields {
    let mut decoder = Decoder::new(input);
    assert_eq!(decoder.array().unwrap(), Some(10));
    PasswordEnvelopeFields {
        version: decoder.u64().unwrap(),
        suite: decoder.u64().unwrap(),
        kind: decoder.u64().unwrap(),
        salt: decoder.bytes().unwrap().to_vec(),
        memory_kib: decoder.u64().unwrap(),
        time_cost: decoder.u64().unwrap(),
        lanes: decoder.u64().unwrap(),
        commitment: decoder.bytes().unwrap().to_vec(),
        root_nonce: decoder.bytes().unwrap().to_vec(),
        wrapped_root: decoder.bytes().unwrap().to_vec(),
    }
}

fn encode_password_envelope(fields: &PasswordEnvelopeFields) -> Vec<u8> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(10).unwrap();
    encoder.u64(fields.version).unwrap();
    encoder.u64(fields.suite).unwrap();
    encoder.u64(fields.kind).unwrap();
    encoder.bytes(&fields.salt).unwrap();
    encoder.u64(fields.memory_kib).unwrap();
    encoder.u64(fields.time_cost).unwrap();
    encoder.u64(fields.lanes).unwrap();
    encoder.bytes(&fields.commitment).unwrap();
    encoder.bytes(&fields.root_nonce).unwrap();
    encoder.bytes(&fields.wrapped_root).unwrap();
    encoder.into_writer()
}

fn expect_unlock_error(
    password: &MasterPassword,
    fields: &PasswordEnvelopeFields,
) -> CryptoErrorCode {
    match unlock_vault_v0alpha1(password, &encode_password_envelope(fields)) {
        Ok(_) => panic!("a mutated synthetic password envelope unexpectedly unlocked"),
        Err(error) => error.code(),
    }
}

#[test]
fn creates_and_unlocks_a_synthetic_vault() {
    let _serial = serial_kdf();
    let password = MasterPassword::from_utf8("synthetic master phrase only".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let unlocked = unlock_vault_v0alpha1(&password, &created.password_envelope).unwrap();

    assert!(unlocked.commitment() == created.session.commitment());
}

#[test]
fn wrong_password_is_only_authentication_failed() {
    let _serial = serial_kdf();
    let password = MasterPassword::from_utf8("synthetic master phrase only".to_owned()).unwrap();
    let wrong = MasterPassword::from_utf8("different synthetic phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let error = match unlock_vault_v0alpha1(&wrong, &created.password_envelope) {
        Ok(_) => panic!("a different synthetic password unexpectedly unlocked the vault"),
        Err(error) => error,
    };

    assert_eq!(error.code(), CryptoErrorCode::AuthenticationFailed);
}

#[test]
fn repeated_creation_with_the_same_password_has_different_envelopes() {
    let _serial = serial_kdf();
    let password = MasterPassword::from_utf8("synthetic master phrase only".to_owned()).unwrap();
    let first = create_vault_v0alpha1(&password).unwrap();
    let second = create_vault_v0alpha1(&password).unwrap();

    assert_ne!(first.password_envelope, second.password_envelope);
}

#[test]
fn unicode_password_bytes_are_not_normalized() {
    let _serial = serial_kdf();
    let composed = MasterPassword::from_utf8("synthetic caf\u{00e9} phrase".to_owned()).unwrap();
    let decomposed = MasterPassword::from_utf8("synthetic cafe\u{0301} phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&composed).unwrap();
    let error = match unlock_vault_v0alpha1(&decomposed, &created.password_envelope) {
        Ok(_) => panic!("distinct UTF-8 password bytes unexpectedly unlocked the vault"),
        Err(error) => error,
    };

    assert_eq!(error.code(), CryptoErrorCode::AuthenticationFailed);
}

#[test]
fn authenticated_password_envelope_fields_reject_mutation() {
    let _serial = serial_kdf();
    let password = MasterPassword::from_utf8("synthetic master phrase only".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let original = decode_password_envelope(&created.password_envelope);

    let mut mutated = decode_password_envelope(&created.password_envelope);
    mutated.salt[0] ^= 0x01;
    assert_eq!(
        expect_unlock_error(&password, &mutated),
        CryptoErrorCode::AuthenticationFailed
    );

    let mut mutated = decode_password_envelope(&created.password_envelope);
    mutated.commitment[16] ^= 0x01;
    assert_eq!(
        expect_unlock_error(&password, &mutated),
        CryptoErrorCode::AuthenticationFailed
    );

    let mut mutated = decode_password_envelope(&created.password_envelope);
    mutated.root_nonce[23] ^= 0x01;
    assert_eq!(
        expect_unlock_error(&password, &mutated),
        CryptoErrorCode::AuthenticationFailed
    );

    for index in [
        0,
        original.wrapped_root.len() / 2,
        original.wrapped_root.len() - 1,
    ] {
        let mut mutated = decode_password_envelope(&created.password_envelope);
        mutated.wrapped_root[index] ^= 0x01;
        assert_eq!(
            expect_unlock_error(&password, &mutated),
            CryptoErrorCode::AuthenticationFailed,
            "wrapped-root mutation at index {index} was not authenticated"
        );
    }
}

#[test]
fn rejects_kdf_parameters_and_unsupported_headers_before_unlocking() {
    let _serial = serial_kdf();
    let password = MasterPassword::from_utf8("synthetic master phrase only".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();

    for mutate in [
        |fields: &mut PasswordEnvelopeFields| fields.memory_kib = 65_535,
        |fields: &mut PasswordEnvelopeFields| fields.time_cost = 2,
        |fields: &mut PasswordEnvelopeFields| fields.lanes = 3,
    ] {
        let mut fields = decode_password_envelope(&created.password_envelope);
        mutate(&mut fields);
        assert_eq!(
            expect_unlock_error(&password, &fields),
            CryptoErrorCode::KdfParamsRejected
        );
    }

    let mut fields = decode_password_envelope(&created.password_envelope);
    fields.version = 1;
    assert_eq!(
        expect_unlock_error(&password, &fields),
        CryptoErrorCode::UnsupportedVersion
    );

    let mut fields = decode_password_envelope(&created.password_envelope);
    fields.suite += 1;
    assert_eq!(
        expect_unlock_error(&password, &fields),
        CryptoErrorCode::UnsupportedSuite
    );
}
