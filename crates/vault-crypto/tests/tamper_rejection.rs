use minicbor::{Decoder, Encoder};
use vault_crypto::{
    CryptoError, CryptoErrorCode, KeyEpoch, MasterPassword, OpaqueRecordId, PaddingBucketV0Alpha1,
    RecordContextV0Alpha1, RevisionId, SecretBytes, VaultCommitment, create_vault_v0alpha1,
    open_record_v0alpha1, seal_record_v0alpha1,
};

struct RecordWire {
    wire_version: u64,
    suite_id: u64,
    object_kind: u64,
    vault_commitment: Vec<u8>,
    opaque_record_id: Vec<u8>,
    revision_id: Vec<u8>,
    key_epoch: u64,
    padding_bucket: u64,
    item_key_nonce: Vec<u8>,
    wrapped_item_key: Vec<u8>,
    body_nonce: Vec<u8>,
    encrypted_body: Vec<u8>,
}

impl RecordWire {
    fn decode(encoded: &[u8]) -> Self {
        let mut decoder = Decoder::new(encoded);
        assert_eq!(decoder.array().unwrap(), Some(12));
        let value = Self {
            wire_version: decoder.u64().unwrap(),
            suite_id: decoder.u64().unwrap(),
            object_kind: decoder.u64().unwrap(),
            vault_commitment: decoder.bytes().unwrap().to_vec(),
            opaque_record_id: decoder.bytes().unwrap().to_vec(),
            revision_id: decoder.bytes().unwrap().to_vec(),
            key_epoch: decoder.u64().unwrap(),
            padding_bucket: decoder.u64().unwrap(),
            item_key_nonce: decoder.bytes().unwrap().to_vec(),
            wrapped_item_key: decoder.bytes().unwrap().to_vec(),
            body_nonce: decoder.bytes().unwrap().to_vec(),
            encrypted_body: decoder.bytes().unwrap().to_vec(),
        };
        assert_eq!(decoder.position(), encoded.len());
        value
    }

    fn encode(&self) -> Vec<u8> {
        let mut encoder = Encoder::new(Vec::new());
        encoder.array(12).unwrap();
        encoder.u64(self.wire_version).unwrap();
        encoder.u64(self.suite_id).unwrap();
        encoder.u64(self.object_kind).unwrap();
        encoder.bytes(&self.vault_commitment).unwrap();
        encoder.bytes(&self.opaque_record_id).unwrap();
        encoder.bytes(&self.revision_id).unwrap();
        encoder.u64(self.key_epoch).unwrap();
        encoder.u64(self.padding_bucket).unwrap();
        encoder.bytes(&self.item_key_nonce).unwrap();
        encoder.bytes(&self.wrapped_item_key).unwrap();
        encoder.bytes(&self.body_nonce).unwrap();
        encoder.bytes(&self.encrypted_body).unwrap();
        encoder.into_writer()
    }
}

fn context(
    commitment: VaultCommitment,
    record_byte: u8,
    revision_byte: u8,
    epoch: u32,
    bucket: PaddingBucketV0Alpha1,
) -> RecordContextV0Alpha1 {
    RecordContextV0Alpha1::new(
        commitment,
        OpaqueRecordId::from_bytes([record_byte; 16]),
        RevisionId::from_bytes([revision_byte; 32]),
        KeyEpoch::new(epoch).unwrap(),
        bucket,
    )
}

fn assert_error_code<T>(result: Result<T, CryptoError>, expected: CryptoErrorCode) {
    match result {
        Ok(_) => panic!("a rejected synthetic record operation unexpectedly succeeded"),
        Err(error) => assert_eq!(error.code(), expected),
    }
}

fn assert_authentication_failed(result: Result<SecretBytes, CryptoError>) {
    assert_error_code(result, CryptoErrorCode::AuthenticationFailed);
}

#[test]
fn rejects_context_swaps_tampering_malformed_envelopes_and_invalid_sizes() {
    let password = MasterPassword::from_utf8("synthetic master phrase only".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let original_context = context(
        created.session.commitment(),
        0x11,
        0x22,
        1,
        PaddingBucketV0Alpha1::Bytes1024,
    );
    let original = SecretBytes::new(b"DEMO_VALUE_ONLY_0001".to_vec()).unwrap();
    let envelope = seal_record_v0alpha1(&created.session, &original_context, &original).unwrap();

    let wrong_vault_for_seal = context(
        VaultCommitment::from_bytes([0x99; 32]),
        0x11,
        0x22,
        1,
        PaddingBucketV0Alpha1::Bytes1024,
    );
    assert_error_code(
        seal_record_v0alpha1(&created.session, &wrong_vault_for_seal, &original),
        CryptoErrorCode::AuthenticationFailed,
    );

    let mismatched_contexts = [
        context(
            VaultCommitment::from_bytes([0x99; 32]),
            0x11,
            0x22,
            1,
            PaddingBucketV0Alpha1::Bytes1024,
        ),
        context(
            created.session.commitment(),
            0x12,
            0x22,
            1,
            PaddingBucketV0Alpha1::Bytes1024,
        ),
        context(
            created.session.commitment(),
            0x11,
            0x23,
            1,
            PaddingBucketV0Alpha1::Bytes1024,
        ),
        context(
            created.session.commitment(),
            0x11,
            0x22,
            2,
            PaddingBucketV0Alpha1::Bytes1024,
        ),
        context(
            created.session.commitment(),
            0x11,
            0x22,
            1,
            PaddingBucketV0Alpha1::Bytes4096,
        ),
    ];
    for mismatched in &mismatched_contexts {
        assert_authentication_failed(open_record_v0alpha1(
            &created.session,
            mismatched,
            &envelope,
        ));
    }

    let other_context = context(
        created.session.commitment(),
        0x33,
        0x44,
        1,
        PaddingBucketV0Alpha1::Bytes1024,
    );
    let other_envelope = seal_record_v0alpha1(&created.session, &other_context, &original).unwrap();
    assert_authentication_failed(open_record_v0alpha1(
        &created.session,
        &original_context,
        &other_envelope,
    ));

    let parsed = RecordWire::decode(&envelope);
    for index in [
        0,
        parsed.wrapped_item_key.len() / 2,
        parsed.wrapped_item_key.len() - 1,
    ] {
        let mut mutated = RecordWire::decode(&envelope);
        mutated.wrapped_item_key[index] ^= 0x01;
        assert_authentication_failed(open_record_v0alpha1(
            &created.session,
            &original_context,
            &mutated.encode(),
        ));
    }
    for index in [
        0,
        parsed.encrypted_body.len() / 2,
        parsed.encrypted_body.len() - 1,
    ] {
        let mut mutated = RecordWire::decode(&envelope);
        mutated.encrypted_body[index] ^= 0x01;
        assert_authentication_failed(open_record_v0alpha1(
            &created.session,
            &original_context,
            &mutated.encode(),
        ));
    }

    let mut truncated = envelope.clone();
    truncated.pop();
    assert_error_code(
        open_record_v0alpha1(&created.session, &original_context, &truncated),
        CryptoErrorCode::NonCanonicalEncoding,
    );
    let mut with_trailing_byte = envelope.clone();
    with_trailing_byte.push(0x00);
    assert_error_code(
        open_record_v0alpha1(&created.session, &original_context, &with_trailing_byte),
        CryptoErrorCode::NonCanonicalEncoding,
    );

    for length in [0, 1, 1_020] {
        let expected = vec![0x5a; length];
        let plaintext = SecretBytes::new(expected.clone()).unwrap();
        let encoded =
            seal_record_v0alpha1(&created.session, &original_context, &plaintext).unwrap();
        let restored = open_record_v0alpha1(&created.session, &original_context, &encoded).unwrap();
        assert_eq!(restored.expose_secret(), expected);
    }

    let too_large_for_1_kib_bucket = SecretBytes::new(vec![0x5a; 1_021]).unwrap();
    assert_error_code(
        seal_record_v0alpha1(
            &created.session,
            &original_context,
            &too_large_for_1_kib_bucket,
        ),
        CryptoErrorCode::LimitsExceeded,
    );

    let largest_context = context(
        created.session.commitment(),
        0x55,
        0x66,
        1,
        PaddingBucketV0Alpha1::Bytes61440,
    );
    let largest_expected = vec![0x5a; 61_436];
    let largest = SecretBytes::new(largest_expected.clone()).unwrap();
    let largest_envelope =
        seal_record_v0alpha1(&created.session, &largest_context, &largest).unwrap();
    let largest_restored =
        open_record_v0alpha1(&created.session, &largest_context, &largest_envelope).unwrap();
    assert_eq!(largest_restored.expose_secret(), largest_expected);
    assert!(largest_envelope.len() <= 65_536);

    assert_error_code(
        SecretBytes::new(vec![0x5a; 61_437]),
        CryptoErrorCode::LimitsExceeded,
    );
}
