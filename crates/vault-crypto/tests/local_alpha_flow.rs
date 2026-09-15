use vault_crypto::{
    KeyEpoch, MasterPassword, OpaqueRecordId, PaddingBucketV0Alpha1, RecordContextV0Alpha1,
    RevisionId, SecretBytes, create_vault_v0alpha1, open_record_v0alpha1, seal_record_v0alpha1,
};

#[test]
fn seals_and_opens_one_explicitly_synthetic_record() {
    let password = MasterPassword::from_utf8("synthetic master phrase only".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let context = RecordContextV0Alpha1::new(
        created.session.commitment(),
        OpaqueRecordId::from_bytes([0x11; 16]),
        RevisionId::from_bytes([0x22; 32]),
        KeyEpoch::new(1).unwrap(),
        PaddingBucketV0Alpha1::Bytes1024,
    );
    let original = SecretBytes::new(b"DEMO_VALUE_ONLY_0001".to_vec()).unwrap();

    let envelope = seal_record_v0alpha1(&created.session, &context, &original).unwrap();
    let restored = open_record_v0alpha1(&created.session, &context, &envelope).unwrap();

    assert_eq!(restored.expose_secret(), b"DEMO_VALUE_ONLY_0001");
    assert!(envelope.len() <= 65_536);
}
