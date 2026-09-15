use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use proptest::prelude::*;
use serde::Deserialize;
use zeroize::{Zeroize, Zeroizing};

use crate::entropy::{
    EntropySource, RecordSealingEntropy, VaultCreationEntropy, with_record_sealing_entropy,
    with_vault_creation_entropy,
};
use crate::secret::HeapSecretKey;
use crate::{
    CryptoError, KeyEpoch, MasterPassword, OpaqueRecordId, PaddingBucketV0Alpha1,
    RecordContextV0Alpha1, RevisionId, SecretBytes, VaultCommitment, VaultSession,
    open_record_v0alpha1, seal_record_v0alpha1,
};

use super::codec::{
    encode_password_envelope, encode_record_envelope, item_body_aad, item_dek_aad,
    password_root_aad,
};
use super::kdf::with_candidate_password_kek;

const VECTOR_STATUS: &str = "compatibility-regression-only-not-independently-verified";
const VECTOR_PASSWORD: &str = "synthetic vector phrase";
const VECTOR_PAYLOAD: &str = "DEMO_VALUE_ONLY_0001";
const VECTOR_RECORD_ID_BYTE: u8 = 17;
const VECTOR_REVISION_ID_BYTE: u8 = 34;

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

struct SequentialEntropy {
    bytes: Vec<u8>,
    offset: usize,
}

impl SequentialEntropy {
    fn new(bytes: Vec<u8>) -> Self {
        Self { bytes, offset: 0 }
    }

    fn is_exhausted(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

impl EntropySource for SequentialEntropy {
    fn fill(&mut self, destination: &mut [u8]) -> Result<(), CryptoError> {
        let end = self
            .offset
            .checked_add(destination.len())
            .ok_or(CryptoError::RngUnavailable)?;
        let source = self
            .bytes
            .get(self.offset..end)
            .ok_or(CryptoError::RngUnavailable)?;
        destination.copy_from_slice(source);
        self.offset = end;
        Ok(())
    }
}

struct DeterministicCreatedVault {
    password_envelope: Vec<u8>,
    session: VaultSession,
}

fn create_vault_with_test_entropy(
    password: &MasterPassword,
    source: &mut impl EntropySource,
) -> Result<DeterministicCreatedVault, CryptoError> {
    with_vault_creation_entropy(source, |entropy| {
        let VaultCreationEntropy {
            salt,
            commitment,
            root_key,
            root_nonce,
        } = entropy;
        let aad = password_root_aad(&salt, &commitment)?;
        let wrapped_root =
            with_candidate_password_kek(password.expose_bytes(), &salt, |password_kek| {
                let cipher = XChaCha20Poly1305::new_from_slice(password_kek)
                    .map_err(|_| CryptoError::InvalidLength)?;
                let nonce: &XNonce = (&root_nonce).into();
                root_key.with_bytes(|root_key| {
                    cipher
                        .encrypt(
                            nonce,
                            Payload {
                                msg: root_key,
                                aad: &aad,
                            },
                        )
                        .map_err(|_| CryptoError::AuthenticationFailed)
                })
            })?;
        let password_envelope =
            encode_password_envelope(&salt, &commitment, &root_nonce, &wrapped_root)?;
        let session = VaultSession::new(
            root_key,
            VaultCommitment::from_bytes(commitment),
            KeyEpoch::initial(),
        );

        Ok(DeterministicCreatedVault {
            password_envelope,
            session,
        })
    })
}

fn seal_record_with_test_entropy(
    session: &VaultSession,
    context: &RecordContextV0Alpha1,
    plaintext: &SecretBytes,
    source: &mut impl EntropySource,
) -> Result<Vec<u8>, CryptoError> {
    with_record_sealing_entropy(source, |mut entropy| {
        let RecordSealingEntropy {
            item_dek,
            item_key_nonce,
            body_nonce,
        } = &mut entropy;
        let bucket_bytes = context.padding_bucket_bytes();
        let plaintext_bytes = plaintext.expose_secret();
        let encoded_length = 4_usize
            .checked_add(plaintext_bytes.len())
            .ok_or(CryptoError::LimitsExceeded)?;
        if encoded_length > bucket_bytes {
            return Err(CryptoError::LimitsExceeded);
        }

        let mut padded_body = Zeroizing::new(vec![0_u8; bucket_bytes]);
        let plaintext_length =
            u32::try_from(plaintext_bytes.len()).map_err(|_| CryptoError::LimitsExceeded)?;
        padded_body[..4].copy_from_slice(&plaintext_length.to_be_bytes());
        padded_body[4..encoded_length].copy_from_slice(plaintext_bytes);

        let dek_aad = item_dek_aad(context)?;
        let body_aad = item_body_aad(context)?;
        let wrapped_item_key = session.wrap_item_dek(item_key_nonce, item_dek, &dek_aad)?;
        let cipher = item_dek
            .with_bytes(XChaCha20Poly1305::new_from_slice)
            .map_err(|_| CryptoError::InvalidLength)?;
        let nonce: &XNonce = (&*body_nonce).into();
        let encrypted_body = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: padded_body.as_slice(),
                    aad: &body_aad,
                },
            )
            .map_err(|_| CryptoError::AuthenticationFailed)?;

        item_dek.zeroize();
        padded_body.zeroize();
        encode_record_envelope(
            context,
            item_key_nonce,
            &wrapped_item_key,
            body_nonce,
            &encrypted_body,
        )
    })
}

fn fixed_test_session_and_context() -> (VaultSession, RecordContextV0Alpha1) {
    let commitment = VaultCommitment::from_bytes([0x10; 32]);
    let session = VaultSession::new(
        HeapSecretKey::synthetic_filled(0x20),
        commitment.clone(),
        KeyEpoch::initial(),
    );
    let context = RecordContextV0Alpha1::new(
        commitment,
        OpaqueRecordId::from_bytes([VECTOR_RECORD_ID_BYTE; 16]),
        RevisionId::from_bytes([VECTOR_REVISION_ID_BYTE; 32]),
        KeyEpoch::new(1).unwrap(),
        PaddingBucketV0Alpha1::Bytes1024,
    );
    (session, context)
}

fn generate_compatibility_vector() -> Result<CompatibilityVector, CryptoError> {
    let password = MasterPassword::from_utf8(VECTOR_PASSWORD.to_owned())?;
    let mut vault_entropy = SequentialEntropy::new((0_u8..=0x67).collect());
    let created = create_vault_with_test_entropy(&password, &mut vault_entropy)?;
    assert!(vault_entropy.is_exhausted());

    let context = RecordContextV0Alpha1::new(
        created.session.commitment(),
        OpaqueRecordId::from_bytes([VECTOR_RECORD_ID_BYTE; 16]),
        RevisionId::from_bytes([VECTOR_REVISION_ID_BYTE; 32]),
        KeyEpoch::new(1)?,
        PaddingBucketV0Alpha1::Bytes1024,
    );
    let plaintext = SecretBytes::new(VECTOR_PAYLOAD.as_bytes().to_vec())?;
    let mut record_entropy = SequentialEntropy::new((0x80_u8..=0xcf).collect());
    let record_envelope =
        seal_record_with_test_entropy(&created.session, &context, &plaintext, &mut record_entropy)?;
    assert!(record_entropy.is_exhausted());

    Ok(CompatibilityVector {
        status: VECTOR_STATUS.to_owned(),
        wire_version: 0,
        suite_id: 41_217,
        password: VECTOR_PASSWORD.to_owned(),
        payload: VECTOR_PAYLOAD.to_owned(),
        opaque_record_id_byte: VECTOR_RECORD_ID_BYTE,
        revision_id_byte: VECTOR_REVISION_ID_BYTE,
        key_epoch: 1,
        padding_bucket: 1_024,
        password_envelope_bytes: created.password_envelope,
        record_envelope_bytes: record_envelope,
    })
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 32,
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn one_kib_bucket_round_trips_every_supported_synthetic_length(
        plaintext_length in 0_usize..=1_020,
    ) {
        let (session, context) = fixed_test_session_and_context();
        let expected = vec![0x5a; plaintext_length];
        let plaintext = SecretBytes::new(expected.clone()).unwrap();
        let envelope = seal_record_v0alpha1(&session, &context, &plaintext).unwrap();
        let opened = open_record_v0alpha1(&session, &context, &envelope).unwrap();

        prop_assert_eq!(opened.expose_secret(), expected.as_slice());
    }
}

#[test]
fn deterministic_entropy_matches_committed_compatibility_vector() {
    let generated = generate_compatibility_vector().unwrap();
    let committed: CompatibilityVector = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/synthetic/v0alpha1-vectors.json"
    ))
    .unwrap();

    assert!(!generated.password_envelope_bytes.is_empty());
    assert!(!generated.record_envelope_bytes.is_empty());
    assert!(!committed.password_envelope_bytes.is_empty());
    assert!(!committed.record_envelope_bytes.is_empty());
    assert_eq!(generated.status, committed.status);
    assert_eq!(generated.wire_version, committed.wire_version);
    assert_eq!(generated.suite_id, committed.suite_id);
    assert_eq!(generated.password, committed.password);
    assert_eq!(generated.payload, committed.payload);
    assert_eq!(
        generated.opaque_record_id_byte,
        committed.opaque_record_id_byte
    );
    assert_eq!(generated.revision_id_byte, committed.revision_id_byte);
    assert_eq!(generated.key_epoch, committed.key_epoch);
    assert_eq!(generated.padding_bucket, committed.padding_bucket);
    assert_eq!(
        generated.password_envelope_bytes,
        committed.password_envelope_bytes
    );
    assert_eq!(
        generated.record_envelope_bytes,
        committed.record_envelope_bytes
    );
}

const XCHACHA_KEY_HEX: &str = "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f";
const XCHACHA_NONCE_HEX: &str = "404142434445464748494a4b4c4d4e4f5051525354555657";
const XCHACHA_AAD_HEX: &str = "50515253c0c1c2c3c4c5c6c7";
const XCHACHA_PLAINTEXT_HEX: &str = concat!(
    "4c616469657320616e642047656e746c656d656e206f662074686520636c6173",
    "73206f66202739393a204966204920636f756c64206f6666657220796f75206f",
    "6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73",
    "637265656e20776f756c642062652069742e",
);
const XCHACHA_CIPHERTEXT_AND_TAG_HEX: &str = concat!(
    "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb",
    "731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452",
    "2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9",
    "21f9664c97637da9768812f615c68b13b52e",
    "c0875924c1c7987947deafd8780acf49",
);

fn decode_hex(input: &str) -> Vec<u8> {
    assert!(input.len().is_multiple_of(2));
    input
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).unwrap();
            u8::from_str_radix(text, 16).unwrap()
        })
        .collect()
}

#[test]
fn xchacha20_poly1305_matches_upstream_known_answer() {
    // Source: draft-irtf-cfrg-xchacha-03, Appendix A.3.1.
    // https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha-03#appendix-A.3.1
    let key = decode_hex(XCHACHA_KEY_HEX);
    let nonce: [u8; 24] = decode_hex(XCHACHA_NONCE_HEX).try_into().unwrap();
    let aad = decode_hex(XCHACHA_AAD_HEX);
    let plaintext = decode_hex(XCHACHA_PLAINTEXT_HEX);
    let expected = decode_hex(XCHACHA_CIPHERTEXT_AND_TAG_HEX);

    let cipher = XChaCha20Poly1305::new_from_slice(&key).unwrap();
    let nonce: &XNonce = (&nonce).into();
    let actual = cipher
        .encrypt(
            nonce,
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .unwrap();

    assert_eq!(actual, expected);
}
