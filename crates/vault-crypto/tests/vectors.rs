use serde::Deserialize;
use vault_crypto::{
    KeyEpoch, MasterPassword, OpaqueRecordId, PaddingBucketV0Alpha1, RecordContextV0Alpha1,
    RevisionId, open_record_v0alpha1, unlock_vault_v0alpha1,
};

#[derive(Deserialize)]
struct CompatibilityVector {
    status: String,
    wire_version: u64,
    suite_id: u64,
    password: String,
    payload: String,
    opaque_record_id_byte: u8,
    revision_id_byte: u8,
    key_epoch: u32,
    padding_bucket: usize,
    password_envelope_bytes: Vec<u8>,
    record_envelope_bytes: Vec<u8>,
}

#[test]
fn committed_vector_unlocks_and_opens_through_public_api() {
    let vector: CompatibilityVector = serde_json::from_str(include_str!(
        "../../../tests/fixtures/synthetic/v0alpha1-vectors.json"
    ))
    .unwrap();

    assert_eq!(
        vector.status,
        "compatibility-regression-only-not-independently-verified"
    );
    assert_eq!(vector.wire_version, 0);
    assert_eq!(vector.suite_id, 41_217);
    assert_eq!(vector.password, "synthetic vector phrase");
    assert_eq!(vector.payload, "DEMO_VALUE_ONLY_0001");
    assert_eq!(vector.opaque_record_id_byte, 17);
    assert_eq!(vector.revision_id_byte, 34);
    assert_eq!(vector.key_epoch, 1);
    assert_eq!(vector.padding_bucket, 1_024);
    assert!(!vector.password_envelope_bytes.is_empty());
    assert!(!vector.record_envelope_bytes.is_empty());

    let password = MasterPassword::from_utf8(vector.password).unwrap();
    let session = unlock_vault_v0alpha1(&password, &vector.password_envelope_bytes).unwrap();
    let context = RecordContextV0Alpha1::new(
        session.commitment(),
        OpaqueRecordId::from_bytes([vector.opaque_record_id_byte; 16]),
        RevisionId::from_bytes([vector.revision_id_byte; 32]),
        KeyEpoch::new(vector.key_epoch).unwrap(),
        PaddingBucketV0Alpha1::Bytes1024,
    );
    let opened = open_record_v0alpha1(&session, &context, &vector.record_envelope_bytes).unwrap();

    assert_eq!(opened.expose_secret(), vector.payload.as_bytes());
}
