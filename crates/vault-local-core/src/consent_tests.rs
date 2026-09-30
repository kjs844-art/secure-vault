use crate::LocalVaultErrorCode;
use crate::consent::{
    CONSENT_SCHEMA_VERSION, ConsentCenterDocumentV1, ConsentStateV1, DecodedConsentCenter,
    EvidenceSourceV1, decode_consent_center, encode_consent_center,
};
use crate::consent_synthetic::{
    build_synthetic_consent_document_v1, encode_synthetic_future_consent_document_v2,
};
use crate::ids::EntityIdV1;

#[test]
fn synthetic_consent_document_roundtrips_canonically() {
    let document = build_synthetic_consent_document_v1().expect("synthetic document is valid");
    let encoded = encode_consent_center(&document).expect("synthetic document encodes canonically");
    match decode_consent_center(&encoded).expect("encoded document decodes") {
        DecodedConsentCenter::Current(decoded) => {
            assert_eq!(decoded.schema_version, CONSENT_SCHEMA_VERSION);
            assert_eq!(decoded.consent_grants.len(), 2);
            assert_eq!(decoded.subscriptions.len(), 1);
            assert_eq!(
                decoded.subscriptions[0].consent_refs.len(),
                document.subscriptions[0].consent_refs.len()
            );
        }
        DecodedConsentCenter::UpgradeRequired { version } => {
            panic!("current schema unexpectedly reported upgrade required: {version}");
        }
    }
}

#[test]
fn withdrawn_grant_requires_timestamp_and_non_user_evidence() {
    let mut document = build_synthetic_consent_document_v1().expect("synthetic document is valid");
    document.consent_grants[1].withdrawn_at = None;
    assert_eq!(
        expect_encode_err(encode_consent_center(&document)),
        LocalVaultErrorCode::InvalidItem
    );

    let mut document = build_synthetic_consent_document_v1().expect("synthetic document is valid");
    document.consent_grants[1].evidence.source = EvidenceSourceV1::User;
    assert_eq!(
        expect_encode_err(encode_consent_center(&document)),
        LocalVaultErrorCode::InvalidItem
    );

    let mut document = build_synthetic_consent_document_v1().expect("synthetic document is valid");
    document.consent_grants[0].state = ConsentStateV1::Withdrawn;
    assert_eq!(
        expect_encode_err(encode_consent_center(&document)),
        LocalVaultErrorCode::InvalidItem
    );
}

#[test]
fn duplicate_consent_ids_and_dangling_subscription_refs_are_rejected() {
    let mut document = build_synthetic_consent_document_v1().expect("synthetic document is valid");
    document.consent_grants[1].consent_id = document.consent_grants[0].consent_id;
    assert_eq!(
        expect_encode_err(encode_consent_center(&document)),
        LocalVaultErrorCode::InvalidItem
    );

    let mut document = build_synthetic_consent_document_v1().expect("synthetic document is valid");
    document.subscriptions[0]
        .consent_refs
        .push(EntityIdV1::from_bytes([0xff; 16]));
    assert_eq!(
        expect_encode_err(encode_consent_center(&document)),
        LocalVaultErrorCode::InvalidItem
    );

    let mut document = build_synthetic_consent_document_v1().expect("synthetic document is valid");
    document.subscriptions[0]
        .consent_refs
        .push(document.consent_grants[0].consent_id);
    assert_eq!(
        expect_encode_err(encode_consent_center(&document)),
        LocalVaultErrorCode::InvalidItem
    );
}

#[test]
fn future_consent_schema_version_is_preserved_and_reported() {
    let encoded = encode_synthetic_future_consent_document_v2();
    match decode_consent_center(&encoded).expect("future version prefix decodes") {
        DecodedConsentCenter::UpgradeRequired { version } => {
            assert_eq!(version, CONSENT_SCHEMA_VERSION + 1);
        }
        DecodedConsentCenter::Current(_) => {
            panic!("future version unexpectedly decoded as current schema");
        }
    }
}

#[test]
fn non_canonical_and_malformed_documents_are_rejected() {
    let document = build_synthetic_consent_document_v1().expect("synthetic document is valid");
    let encoded = encode_consent_center(&document).expect("synthetic document encodes canonically");

    let truncated = &encoded[..encoded.len() - 1];
    assert_eq!(
        expect_err(decode_consent_center(truncated)),
        LocalVaultErrorCode::NonCanonicalEncoding
    );

    let mut extra = encoded.clone();
    extra.push(0x00);
    assert_eq!(
        expect_err(decode_consent_center(&extra)),
        LocalVaultErrorCode::NonCanonicalEncoding
    );

    let empty = vec![0x80];
    assert_eq!(
        expect_err(decode_consent_center(&empty)),
        LocalVaultErrorCode::NonCanonicalEncoding
    );
}

#[test]
fn empty_consent_document_is_valid() {
    let document = ConsentCenterDocumentV1 {
        schema_version: CONSENT_SCHEMA_VERSION,
        consent_grants: Vec::new(),
        subscriptions: Vec::new(),
    };
    let encoded = encode_consent_center(&document).expect("empty document is valid");
    match decode_consent_center(&encoded).expect("empty document decodes") {
        DecodedConsentCenter::Current(decoded) => {
            assert!(decoded.consent_grants.is_empty());
            assert!(decoded.subscriptions.is_empty());
        }
        DecodedConsentCenter::UpgradeRequired { .. } => {
            panic!("empty current document reported upgrade required");
        }
    }
}

fn expect_err(result: Result<DecodedConsentCenter, crate::LocalVaultError>) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("expected validation error, got success"),
        Err(error) => error.code(),
    }
}

fn expect_encode_err(result: Result<Vec<u8>, crate::LocalVaultError>) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("expected validation error, got success"),
        Err(error) => error.code(),
    }
}
