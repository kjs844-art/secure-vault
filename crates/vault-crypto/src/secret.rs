use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use zeroize::Zeroizing;

use crate::CryptoError;

const MAX_MASTER_PASSWORD_BYTES: usize = 1_024;
const MAX_SECRET_BYTES: usize = 61_436;
const SECRET_KEY_BYTES: usize = 32;

/// Crate-private, heap-stable ownership for a root key or Item DEK.
///
/// The allocation is created before sensitive bytes are copied into it. Moving this owner only
/// moves the `Box` pointer; the key bytes remain inside the same zeroizing heap allocation.
pub(crate) struct HeapSecretKey {
    bytes: Box<Zeroizing<[u8; SECRET_KEY_BYTES]>>,
}

impl HeapSecretKey {
    pub(crate) fn copy_from_zeroizing_block<const N: usize>(
        source: &Zeroizing<[u8; N]>,
        range: std::ops::Range<usize>,
    ) -> Result<Self, CryptoError> {
        let source = source.get(range).ok_or(CryptoError::InvalidLength)?;
        Self::copy_from_validated_slice(source)
    }

    pub(crate) fn copy_from_zeroizing_vec(
        source: &Zeroizing<Vec<u8>>,
    ) -> Result<Self, CryptoError> {
        Self::copy_from_validated_slice(source.as_slice())
    }

    fn copy_from_validated_slice(source: &[u8]) -> Result<Self, CryptoError> {
        if source.len() != SECRET_KEY_BYTES {
            return Err(CryptoError::InvalidLength);
        }

        let mut bytes = Box::new(Zeroizing::new([0_u8; SECRET_KEY_BYTES]));
        bytes.copy_from_slice(source);
        Ok(Self { bytes })
    }

    pub(crate) fn with_bytes<R>(&self, operation: impl for<'a> FnOnce(&'a [u8]) -> R) -> R {
        operation(self.bytes.as_slice())
    }

    pub(crate) fn zeroize(&mut self) {
        zeroize::Zeroize::zeroize(self.bytes.as_mut());
    }

    #[cfg(test)]
    pub(crate) fn synthetic_filled(byte: u8) -> Self {
        let mut bytes = Box::new(Zeroizing::new([0_u8; SECRET_KEY_BYTES]));
        bytes.fill(byte);
        Self { bytes }
    }

    #[cfg(test)]
    pub(crate) fn matches_bytes(&self, expected: &[u8]) -> bool {
        self.bytes.as_slice() == expected
    }

    #[cfg(test)]
    pub(crate) fn allocation_address(&self) -> usize {
        self.bytes.as_slice().as_ptr() as usize
    }
}

/// Master-password bytes owned by a zeroizing allocation.
///
/// This type deliberately implements no formatting, cloning, or serialization traits.
pub struct MasterPassword(Zeroizing<Vec<u8>>);

impl MasterPassword {
    /// Move the UTF-8 bytes into zeroizing storage without Unicode normalization.
    pub fn from_utf8(value: String) -> Result<Self, CryptoError> {
        let value = Zeroizing::new(value.into_bytes());
        if value.is_empty() || value.len() > MAX_MASTER_PASSWORD_BYTES {
            return Err(CryptoError::InvalidLength);
        }
        Ok(Self(value))
    }

    #[allow(dead_code)]
    pub(crate) fn expose_bytes(&self) -> &[u8] {
        self.0.as_slice()
    }
}

/// Plaintext bytes owned by a zeroizing allocation.
///
/// This type deliberately implements no formatting, cloning, or serialization traits.
pub struct SecretBytes(Zeroizing<Vec<u8>>);

impl SecretBytes {
    /// Move plaintext into zeroizing storage after enforcing the v0alpha1 size limit.
    pub fn new(value: Vec<u8>) -> Result<Self, CryptoError> {
        let value = Zeroizing::new(value);
        if value.len() > MAX_SECRET_BYTES {
            return Err(CryptoError::LimitsExceeded);
        }
        Ok(Self(value))
    }

    /// Borrow plaintext for its immediate intended use.
    ///
    /// Callers must never log, format, serialize for diagnostics, or retain this slice.
    pub fn expose_secret(&self) -> &[u8] {
        self.0.as_slice()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct VaultCommitment([u8; 32]);

impl VaultCommitment {
    pub const fn from_bytes(value: [u8; 32]) -> Self {
        Self(value)
    }

    pub(crate) const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct OpaqueRecordId([u8; 16]);

impl OpaqueRecordId {
    pub const fn from_bytes(value: [u8; 16]) -> Self {
        Self(value)
    }

    pub(crate) const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct RevisionId([u8; 32]);

impl RevisionId {
    pub const fn from_bytes(value: [u8; 32]) -> Self {
        Self(value)
    }

    pub(crate) const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct KeyEpoch(u32);

impl KeyEpoch {
    pub const fn initial() -> Self {
        Self(1)
    }

    pub const fn new(value: u32) -> Result<Self, CryptoError> {
        if value == 0 {
            return Err(CryptoError::InvalidLength);
        }
        Ok(Self(value))
    }

    pub const fn get(&self) -> u32 {
        self.0
    }

    pub const fn checked_next(&self) -> Result<Self, CryptoError> {
        match self.0.checked_add(1) {
            Some(next) => Ok(Self(next)),
            None => Err(CryptoError::LimitsExceeded),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum PaddingBucketV0Alpha1 {
    Bytes1024,
    Bytes4096,
    Bytes16384,
    Bytes61440,
}

impl PaddingBucketV0Alpha1 {
    pub(crate) const fn byte_len(&self) -> usize {
        match self {
            Self::Bytes1024 => 1_024,
            Self::Bytes4096 => 4_096,
            Self::Bytes16384 => 16_384,
            Self::Bytes61440 => 61_440,
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct RecordContextV0Alpha1 {
    commitment: VaultCommitment,
    record_id: OpaqueRecordId,
    revision_id: RevisionId,
    key_epoch: KeyEpoch,
    padding_bucket: PaddingBucketV0Alpha1,
}

impl RecordContextV0Alpha1 {
    pub const fn new(
        commitment: VaultCommitment,
        record_id: OpaqueRecordId,
        revision_id: RevisionId,
        key_epoch: KeyEpoch,
        padding_bucket: PaddingBucketV0Alpha1,
    ) -> Self {
        Self {
            commitment,
            record_id,
            revision_id,
            key_epoch,
            padding_bucket,
        }
    }

    pub(crate) const fn commitment_bytes(&self) -> &[u8; 32] {
        self.commitment.as_bytes()
    }

    pub(crate) const fn record_id_bytes(&self) -> &[u8; 16] {
        self.record_id.as_bytes()
    }

    pub(crate) const fn revision_id_bytes(&self) -> &[u8; 32] {
        self.revision_id.as_bytes()
    }

    pub(crate) const fn key_epoch_value(&self) -> u32 {
        self.key_epoch.get()
    }

    pub(crate) const fn padding_bucket_bytes(&self) -> usize {
        self.padding_bucket.byte_len()
    }
}

/// An unlocked root key held only in zeroizing memory.
///
/// This type deliberately implements no formatting, cloning, or serialization traits and
/// exposes no root-key getter.
pub struct VaultSession {
    #[allow(dead_code)]
    root_key: HeapSecretKey,
    commitment: VaultCommitment,
    key_epoch: KeyEpoch,
}

impl VaultSession {
    #[allow(dead_code)]
    pub(crate) fn new(
        root_key: HeapSecretKey,
        commitment: VaultCommitment,
        key_epoch: KeyEpoch,
    ) -> Self {
        Self {
            root_key,
            commitment,
            key_epoch,
        }
    }

    pub fn key_epoch(&self) -> KeyEpoch {
        self.key_epoch.clone()
    }

    pub fn commitment(&self) -> VaultCommitment {
        self.commitment.clone()
    }

    pub(crate) const fn commitment_bytes(&self) -> &[u8; 32] {
        self.commitment.as_bytes()
    }

    pub(crate) const fn key_epoch_value(&self) -> u32 {
        self.key_epoch.get()
    }

    /// Wrap an Item DEK without ever exposing or returning the Vault Root Key.
    pub(crate) fn wrap_item_dek(
        &self,
        nonce: &[u8; 24],
        item_dek: &HeapSecretKey,
        aad: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        let cipher = self
            .root_key
            .with_bytes(XChaCha20Poly1305::new_from_slice)
            .map_err(|_| CryptoError::InvalidLength)?;
        let nonce: &XNonce = nonce.into();
        item_dek.with_bytes(|item_dek| {
            cipher
                .encrypt(nonce, Payload { msg: item_dek, aad })
                .map_err(|_| CryptoError::AuthenticationFailed)
        })
    }

    /// Unwrap an Item DEK without ever exposing or returning the Vault Root Key.
    ///
    /// The returned Item DEK is already owned by a zeroizing allocation before crossing the
    /// module boundary.
    pub(crate) fn unwrap_item_dek(
        &self,
        nonce: &[u8; 24],
        wrapped_item_dek: &[u8],
        aad: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        let cipher = self
            .root_key
            .with_bytes(XChaCha20Poly1305::new_from_slice)
            .map_err(|_| CryptoError::InvalidLength)?;
        let nonce: &XNonce = nonce.into();
        let decrypted = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: wrapped_item_dek,
                    aad,
                },
            )
            .map_err(|_| CryptoError::AuthenticationFailed)?;
        Ok(Zeroizing::new(decrypted))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CryptoErrorCode;

    fn expect_error_code<T>(result: Result<T, CryptoError>) -> CryptoErrorCode {
        match result {
            Ok(_) => panic!("an invalid synthetic test value was unexpectedly accepted"),
            Err(error) => error.code(),
        }
    }

    #[test]
    fn master_password_enforces_utf8_byte_boundaries_without_normalizing() {
        assert_eq!(
            expect_error_code(MasterPassword::from_utf8(String::new())),
            CryptoErrorCode::InvalidLength
        );
        assert_eq!(
            expect_error_code(MasterPassword::from_utf8("x".repeat(1_025))),
            CryptoErrorCode::InvalidLength
        );

        let composed = MasterPassword::from_utf8("caf\u{00e9}".to_owned()).unwrap();
        let decomposed = MasterPassword::from_utf8("cafe\u{0301}".to_owned()).unwrap();
        assert_eq!(composed.expose_bytes(), "caf\u{00e9}".as_bytes());
        assert_eq!(decomposed.expose_bytes(), "cafe\u{0301}".as_bytes());
        assert_ne!(composed.expose_bytes(), decomposed.expose_bytes());
    }

    #[test]
    fn secret_bytes_accepts_empty_and_maximum_but_rejects_larger_values() {
        assert_eq!(SecretBytes::new(Vec::new()).unwrap().expose_secret(), b"");
        assert_eq!(
            SecretBytes::new(vec![0x5a; 61_436])
                .unwrap()
                .expose_secret()
                .len(),
            61_436
        );
        assert_eq!(
            expect_error_code(SecretBytes::new(vec![0x5a; 61_437])),
            CryptoErrorCode::LimitsExceeded
        );
    }

    #[test]
    fn key_epoch_rejects_zero() {
        assert_eq!(
            expect_error_code(KeyEpoch::new(0)),
            CryptoErrorCode::InvalidLength
        );
        assert!(KeyEpoch::new(1).is_ok());
    }

    #[test]
    fn session_exposes_only_its_public_commitment_value() {
        let commitment = VaultCommitment::from_bytes([0x21; 32]);
        let session = VaultSession::new(
            HeapSecretKey::synthetic_filled(0x42),
            commitment.clone(),
            KeyEpoch::initial(),
        );
        assert!(session.commitment() == commitment);
    }
}
