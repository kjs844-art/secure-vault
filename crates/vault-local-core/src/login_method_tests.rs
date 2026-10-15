use crate::LocalVaultErrorCode;
use crate::ids::EntityIdV1;
use crate::login_method::{
    DecodedLoginMethodRegistry, LOGIN_METHOD_SCHEMA_VERSION, LoginMethodRegistryV1,
    decode_login_method_registry, encode_login_method_registry,
};
use crate::login_method_synthetic::{
    build_synthetic_login_method_registry_v1, encode_synthetic_future_login_registry_v2,
};

#[test]
fn synthetic_login_method_registry_roundtrips_canonically() {
    let registry = build_synthetic_login_method_registry_v1().expect("synthetic registry is valid");
    let encoded =
        encode_login_method_registry(&registry).expect("synthetic registry encodes canonically");
    match decode_login_method_registry(&encoded).expect("encoded registry decodes") {
        DecodedLoginMethodRegistry::Current(decoded) => {
            assert_eq!(decoded.schema_version, LOGIN_METHOD_SCHEMA_VERSION);
            assert_eq!(decoded.accounts.len(), 1);
            assert_eq!(decoded.accounts[0].login_methods.len(), 2);
        }
        DecodedLoginMethodRegistry::UpgradeRequired { version } => {
            panic!("current schema unexpectedly reported upgrade required: {version}");
        }
    }
}

#[test]
fn manual_and_official_provenance_are_both_representable() {
    let registry = build_synthetic_login_method_registry_v1().expect("synthetic registry is valid");
    let official = registry.accounts[0].login_methods.iter().any(|method| {
        method.provenance == crate::login_method::LoginProvenanceV1::OfficialIntegration
    });
    let manual = registry.accounts[0]
        .login_methods
        .iter()
        .any(|method| method.provenance == crate::login_method::LoginProvenanceV1::UserRecorded);
    assert!(
        official,
        "official integration provenance must be representable"
    );
    assert!(manual, "user recorded provenance must be representable");
}

#[test]
fn account_without_login_methods_is_rejected() {
    let mut registry =
        build_synthetic_login_method_registry_v1().expect("synthetic registry is valid");
    registry.accounts[0].login_methods.clear();
    assert_eq!(
        expect_encode_err(encode_login_method_registry(&registry)),
        LocalVaultErrorCode::LimitsExceeded
    );
}

#[test]
fn duplicate_account_ids_and_method_ids_are_rejected() {
    let mut registry =
        build_synthetic_login_method_registry_v1().expect("synthetic registry is valid");
    let duplicate = clone_account(&registry);
    registry.accounts.push(duplicate);
    assert_eq!(
        expect_encode_err(encode_login_method_registry(&registry)),
        LocalVaultErrorCode::InvalidItem
    );

    let mut registry =
        build_synthetic_login_method_registry_v1().expect("synthetic registry is valid");
    let first = registry.accounts[0].login_methods[0].method_id;
    registry.accounts[0].login_methods[1].method_id = first;
    assert_eq!(
        expect_encode_err(encode_login_method_registry(&registry)),
        LocalVaultErrorCode::InvalidItem
    );
}

fn clone_account(registry: &LoginMethodRegistryV1) -> crate::login_method::AccountLoginRecordV1 {
    let source = &registry.accounts[0];
    let clone_methods = source.login_methods.iter().map(clone_method).collect();
    crate::login_method::AccountLoginRecordV1 {
        account_id: source.account_id,
        service_name: source.service_name.clone(),
        account_identifier: source.account_identifier.clone(),
        login_methods: clone_methods,
        notes: source.notes.clone(),
    }
}

fn clone_method(method: &crate::login_method::LoginMethodV1) -> crate::login_method::LoginMethodV1 {
    crate::login_method::LoginMethodV1 {
        method_id: method.method_id,
        method: method.method,
        provenance: method.provenance,
        recorded_at: clone_timestamp(&method.recorded_at),
        last_observed_at: method.last_observed_at.as_ref().map(clone_timestamp),
        status: method.status,
        notes: method.notes.clone(),
    }
}

fn clone_timestamp(timestamp: &crate::model::UtcTimestampV1) -> crate::model::UtcTimestampV1 {
    crate::model::UtcTimestampV1::new(timestamp.as_str().to_owned())
        .expect("existing timestamp clones validly")
}

#[test]
fn last_observed_before_recorded_is_rejected() {
    let mut registry =
        build_synthetic_login_method_registry_v1().expect("synthetic registry is valid");
    let early = crate::model::UtcTimestampV1::new("2026-01-01T00:00:00Z".to_owned())
        .expect("timestamp is valid");
    registry.accounts[0].login_methods[0].last_observed_at = Some(early);
    assert_eq!(
        expect_encode_err(encode_login_method_registry(&registry)),
        LocalVaultErrorCode::InvalidItem
    );
}

#[test]
fn future_login_registry_schema_version_is_preserved_and_reported() {
    let encoded = encode_synthetic_future_login_registry_v2();
    match decode_login_method_registry(&encoded).expect("future version prefix decodes") {
        DecodedLoginMethodRegistry::UpgradeRequired { version } => {
            assert_eq!(version, LOGIN_METHOD_SCHEMA_VERSION + 1);
        }
        DecodedLoginMethodRegistry::Current(_) => {
            panic!("future version unexpectedly decoded as current schema");
        }
    }
}

#[test]
fn non_canonical_and_malformed_registries_are_rejected() {
    let registry = build_synthetic_login_method_registry_v1().expect("synthetic registry is valid");
    let encoded =
        encode_login_method_registry(&registry).expect("synthetic registry encodes canonically");

    let truncated = &encoded[..encoded.len() - 1];
    assert_eq!(
        expect_decode_err(decode_login_method_registry(truncated)),
        LocalVaultErrorCode::NonCanonicalEncoding
    );

    let mut extra = encoded.clone();
    extra.push(0x00);
    assert_eq!(
        expect_decode_err(decode_login_method_registry(&extra)),
        LocalVaultErrorCode::NonCanonicalEncoding
    );

    let empty = vec![0x80];
    assert_eq!(
        expect_decode_err(decode_login_method_registry(&empty)),
        LocalVaultErrorCode::NonCanonicalEncoding
    );
}

#[test]
fn unknown_entity_id_bytes_are_only_accepted_at_exact_width() {
    let registry = build_synthetic_login_method_registry_v1().expect("synthetic registry is valid");
    let encoded =
        encode_login_method_registry(&registry).expect("synthetic registry encodes canonically");
    match decode_login_method_registry(&encoded).expect("encoded registry decodes") {
        DecodedLoginMethodRegistry::Current(decoded) => {
            assert_eq!(decoded.accounts[0].account_id.as_bytes(), &[0xc1; 16][..]);
        }
        DecodedLoginMethodRegistry::UpgradeRequired { .. } => {
            panic!("current schema unexpectedly reported upgrade required");
        }
    }
    let _ = EntityIdV1::from_bytes([0xff; 16]);
}

fn expect_encode_err(result: Result<Vec<u8>, crate::LocalVaultError>) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("expected validation error, got success"),
        Err(error) => error.code(),
    }
}

fn expect_decode_err(
    result: Result<DecodedLoginMethodRegistry, crate::LocalVaultError>,
) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("expected validation error, got success"),
        Err(error) => error.code(),
    }
}
