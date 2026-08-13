use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use zeroize::{Zeroize, Zeroizing};

use crate::entropy::{EntropySource, OsEntropy, RecordSealingEntropy, with_record_sealing_entropy};
use crate::{CryptoError, RecordContextV0Alpha1, SecretBytes, VaultSession};

use super::codec::{
    RecordEnvelopeFields, decode_record_envelope, encode_record_envelope, item_body_aad,
    item_dek_aad,
};

const ITEM_DEK_BYTES: usize = 32;
const NONCE_BYTES: usize = 24;
const BODY_LENGTH_PREFIX_BYTES: usize = 4;

#[derive(Clone, Copy)]
enum SensitiveBufferKind {
    ItemDek,
    DecryptedBody,
}

/// Own a decrypted allocation and zeroize it before the test-only cleanup signal fires.
struct SensitiveBuffer {
    bytes: Zeroizing<Vec<u8>>,
    kind: SensitiveBufferKind,
}

impl SensitiveBuffer {
    fn new(bytes: Vec<u8>, kind: SensitiveBufferKind) -> Self {
        Self {
            bytes: Zeroizing::new(bytes),
            kind,
        }
    }

    fn as_slice(&self) -> &[u8] {
        self.bytes.as_slice()
    }

    fn len(&self) -> usize {
        self.bytes.len()
    }

    fn zeroize(&mut self) {
        self.bytes.zeroize();
    }
}

impl Drop for SensitiveBuffer {
    fn drop(&mut self) {
        self.bytes.zeroize();
        record_cleanup(self.kind);
    }
}

#[cfg(not(test))]
fn record_cleanup(_kind: SensitiveBufferKind) {}

#[cfg(test)]
std::thread_local! {
    static ITEM_DEK_CLEANUPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static DECRYPTED_BODY_CLEANUPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn record_cleanup(kind: SensitiveBufferKind) {
    match kind {
        SensitiveBufferKind::ItemDek => {
            ITEM_DEK_CLEANUPS.with(|count| count.set(count.get() + 1));
        }
        SensitiveBufferKind::DecryptedBody => {
            DECRYPTED_BODY_CLEANUPS.with(|count| count.set(count.get() + 1));
        }
    }
}

#[cfg(test)]
fn reset_cleanup_counts() {
    ITEM_DEK_CLEANUPS.with(|count| count.set(0));
    DECRYPTED_BODY_CLEANUPS.with(|count| count.set(0));
}

#[cfg(test)]
fn cleanup_counts() -> (usize, usize) {
    let item_dek = ITEM_DEK_CLEANUPS.with(std::cell::Cell::get);
    let decrypted_body = DECRYPTED_BODY_CLEANUPS.with(std::cell::Cell::get);
    (item_dek, decrypted_body)
}

/// Seal one explicitly synthetic record under a fresh random Item DEK.
pub fn seal_record_v0alpha1(
    session: &VaultSession,
    context: &RecordContextV0Alpha1,
    plaintext: &SecretBytes,
) -> Result<Vec<u8>, CryptoError> {
    validate_session_context(session, context)?;
    validate_plaintext_fits_bucket(context, plaintext.expose_secret().len())?;

    let mut entropy = OsEntropy;
    seal_record_with_entropy(session, context, plaintext, &mut entropy)
}

/// Authenticate and open one explicitly synthetic record envelope.
pub fn open_record_v0alpha1(
    session: &VaultSession,
    expected_context: &RecordContextV0Alpha1,
    envelope: &[u8],
) -> Result<SecretBytes, CryptoError> {
    let fields = decode_record_envelope(envelope)?;
    validate_session_context(session, expected_context)?;
    validate_envelope_context(&fields, expected_context)?;

    let item_key_nonce = copy_array::<NONCE_BYTES>(fields.item_key_nonce)?;
    let body_nonce = copy_array::<NONCE_BYTES>(fields.body_nonce)?;
    let dek_aad = item_dek_aad(expected_context)?;
    let body_aad = item_body_aad(expected_context)?;

    let mut item_dek = SensitiveBuffer::new(
        session.unwrap_item_dek(&item_key_nonce, fields.wrapped_item_key, &dek_aad)?,
        SensitiveBufferKind::ItemDek,
    );
    if item_dek.len() != ITEM_DEK_BYTES {
        item_dek.zeroize();
        return Err(CryptoError::AuthenticationFailed);
    }

    let body_cipher = XChaCha20Poly1305::new_from_slice(item_dek.as_slice())
        .map_err(|_| CryptoError::AuthenticationFailed)?;
    item_dek.zeroize();
    let nonce: &XNonce = (&body_nonce).into();
    let mut padded_body = SensitiveBuffer::new(
        body_cipher
            .decrypt(
                nonce,
                Payload {
                    msg: fields.encrypted_body,
                    aad: &body_aad,
                },
            )
            .map_err(|_| CryptoError::AuthenticationFailed)?,
        SensitiveBufferKind::DecryptedBody,
    );

    let plaintext_length = validate_and_read_padded_body(
        padded_body.as_slice(),
        expected_context.padding_bucket_bytes(),
    )?;
    let end = BODY_LENGTH_PREFIX_BYTES + plaintext_length;
    let restored =
        SecretBytes::new(padded_body.as_slice()[BODY_LENGTH_PREFIX_BYTES..end].to_vec())?;
    padded_body.zeroize();
    Ok(restored)
}

fn seal_record_with_entropy(
    session: &VaultSession,
    context: &RecordContextV0Alpha1,
    plaintext: &SecretBytes,
    source: &mut impl EntropySource,
) -> Result<Vec<u8>, CryptoError> {
    with_record_sealing_entropy(source, |entropy| {
        let bucket_bytes = context.padding_bucket_bytes();
        let mut padded_body = Zeroizing::new(vec![0_u8; bucket_bytes]);
        let plaintext_bytes = plaintext.expose_secret();
        let plaintext_length =
            u32::try_from(plaintext_bytes.len()).map_err(|_| CryptoError::LimitsExceeded)?;
        padded_body[..BODY_LENGTH_PREFIX_BYTES].copy_from_slice(&plaintext_length.to_be_bytes());
        let end = BODY_LENGTH_PREFIX_BYTES + plaintext_bytes.len();
        padded_body[BODY_LENGTH_PREFIX_BYTES..end].copy_from_slice(plaintext_bytes);

        seal_prepared_body(session, context, padded_body, entropy)
    })
}

fn seal_prepared_body(
    session: &VaultSession,
    context: &RecordContextV0Alpha1,
    mut padded_body: Zeroizing<Vec<u8>>,
    mut entropy: RecordSealingEntropy,
) -> Result<Vec<u8>, CryptoError> {
    let dek_aad = item_dek_aad(context)?;
    let body_aad = item_body_aad(context)?;
    let wrapped_item_key =
        session.wrap_item_dek(&entropy.item_key_nonce, &entropy.item_dek, &dek_aad)?;

    let body_cipher = XChaCha20Poly1305::new_from_slice(entropy.item_dek.as_slice())
        .map_err(|_| CryptoError::AuthenticationFailed)?;
    let body_nonce: &XNonce = (&entropy.body_nonce).into();
    let encrypted_body = body_cipher
        .encrypt(
            body_nonce,
            Payload {
                msg: padded_body.as_slice(),
                aad: &body_aad,
            },
        )
        .map_err(|_| CryptoError::AuthenticationFailed)?;

    entropy.item_dek.zeroize();
    padded_body.zeroize();
    encode_record_envelope(
        context,
        &entropy.item_key_nonce,
        &wrapped_item_key,
        &entropy.body_nonce,
        &encrypted_body,
    )
}

fn validate_session_context(
    session: &VaultSession,
    context: &RecordContextV0Alpha1,
) -> Result<(), CryptoError> {
    if session.commitment_bytes() != context.commitment_bytes() {
        return Err(CryptoError::AuthenticationFailed);
    }
    Ok(())
}

fn validate_plaintext_fits_bucket(
    context: &RecordContextV0Alpha1,
    plaintext_length: usize,
) -> Result<(), CryptoError> {
    let encoded_length = BODY_LENGTH_PREFIX_BYTES
        .checked_add(plaintext_length)
        .ok_or(CryptoError::LimitsExceeded)?;
    if encoded_length > context.padding_bucket_bytes() {
        return Err(CryptoError::LimitsExceeded);
    }
    Ok(())
}

fn validate_envelope_context(
    fields: &RecordEnvelopeFields<'_>,
    expected: &RecordContextV0Alpha1,
) -> Result<(), CryptoError> {
    if fields.vault_commitment != expected.commitment_bytes()
        || fields.opaque_record_id != expected.record_id_bytes()
        || fields.revision_id != expected.revision_id_bytes()
        || fields.key_epoch != u64::from(expected.key_epoch_value())
        || fields.padding_bucket != expected.padding_bucket_bytes() as u64
    {
        return Err(CryptoError::AuthenticationFailed);
    }
    Ok(())
}

fn validate_and_read_padded_body(
    padded_body: &[u8],
    expected_bucket_bytes: usize,
) -> Result<usize, CryptoError> {
    if padded_body.len() != expected_bucket_bytes || padded_body.len() < BODY_LENGTH_PREFIX_BYTES {
        return Err(CryptoError::AuthenticationFailed);
    }

    let length_bytes =
        copy_array::<BODY_LENGTH_PREFIX_BYTES>(&padded_body[..BODY_LENGTH_PREFIX_BYTES])
            .map_err(|_| CryptoError::AuthenticationFailed)?;
    let plaintext_length = u32::from_be_bytes(length_bytes) as usize;
    let end = BODY_LENGTH_PREFIX_BYTES
        .checked_add(plaintext_length)
        .ok_or(CryptoError::AuthenticationFailed)?;
    if end > padded_body.len() || padded_body[end..].iter().any(|byte| *byte != 0) {
        return Err(CryptoError::AuthenticationFailed);
    }
    Ok(plaintext_length)
}

fn copy_array<const N: usize>(input: &[u8]) -> Result<[u8; N], CryptoError> {
    input.try_into().map_err(|_| CryptoError::InvalidLength)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CryptoErrorCode, KeyEpoch, OpaqueRecordId, PaddingBucketV0Alpha1, RevisionId,
        VaultCommitment,
    };

    fn fixed_session_and_context() -> (VaultSession, RecordContextV0Alpha1) {
        let commitment = VaultCommitment::from_bytes([0x21; 32]);
        let session = VaultSession::new(Zeroizing::new([0x42; 32]), commitment.clone());
        let context = RecordContextV0Alpha1::new(
            commitment,
            OpaqueRecordId::from_bytes([0x11; 16]),
            RevisionId::from_bytes([0x22; 32]),
            KeyEpoch::new(1).unwrap(),
            PaddingBucketV0Alpha1::Bytes1024,
        );
        (session, context)
    }

    fn fixed_record_entropy(seed: u8) -> RecordSealingEntropy {
        RecordSealingEntropy {
            item_dek: Zeroizing::new([seed; 32]),
            item_key_nonce: [seed.wrapping_add(1); 24],
            body_nonce: [seed.wrapping_add(2); 24],
        }
    }

    fn assert_authenticated_body_rejected_and_cleaned(
        session: &VaultSession,
        context: &RecordContextV0Alpha1,
        padded_body: Vec<u8>,
        seed: u8,
    ) {
        let envelope = seal_prepared_body(
            session,
            context,
            Zeroizing::new(padded_body),
            fixed_record_entropy(seed),
        )
        .unwrap();
        reset_cleanup_counts();

        let error = match open_record_v0alpha1(session, context, &envelope) {
            Ok(_) => panic!("an authenticated malformed synthetic body unexpectedly opened"),
            Err(error) => error,
        };

        assert_eq!(error.code(), CryptoErrorCode::AuthenticationFailed);
        assert_eq!(cleanup_counts(), (1, 1));
    }

    #[test]
    fn authenticated_malformed_bodies_are_rejected_and_sensitive_buffers_cleaned() {
        let (session, context) = fixed_session_and_context();

        let declared_length = u32::MAX;
        assert!(declared_length as usize > context.padding_bucket_bytes());
        let mut length_overflow = vec![0_u8; 1_024];
        length_overflow[..4].copy_from_slice(&declared_length.to_be_bytes());
        assert_authenticated_body_rejected_and_cleaned(&session, &context, length_overflow, 0x51);

        let mut nonzero_padding = vec![0_u8; 1_024];
        nonzero_padding[..4].copy_from_slice(&1_u32.to_be_bytes());
        nonzero_padding[4] = 0x5a;
        nonzero_padding[5] = 0x01;
        assert_authenticated_body_rejected_and_cleaned(&session, &context, nonzero_padding, 0x61);
    }
}
