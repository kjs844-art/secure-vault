use zeroize::Zeroizing;

use crate::CryptoError;

const MAX_MASTER_PASSWORD_BYTES: usize = 1_024;
const MAX_SECRET_BYTES: usize = 61_436;

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
}

#[derive(Clone, Eq, PartialEq)]
pub struct OpaqueRecordId([u8; 16]);

impl OpaqueRecordId {
    pub const fn from_bytes(value: [u8; 16]) -> Self {
        Self(value)
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct RevisionId([u8; 32]);

impl RevisionId {
    pub const fn from_bytes(value: [u8; 32]) -> Self {
        Self(value)
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct KeyEpoch(u32);

impl KeyEpoch {
    pub const fn new(value: u32) -> Result<Self, CryptoError> {
        if value == 0 {
            return Err(CryptoError::InvalidLength);
        }
        Ok(Self(value))
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum PaddingBucketV0Alpha1 {
    Bytes1024,
    Bytes4096,
    Bytes16384,
    Bytes61440,
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
}

/// An unlocked root key held only in zeroizing memory.
///
/// This type deliberately implements no formatting, cloning, or serialization traits and
/// exposes no root-key getter.
pub struct VaultSession {
    #[allow(dead_code)]
    root_key: Zeroizing<[u8; 32]>,
    commitment: VaultCommitment,
}

impl VaultSession {
    #[allow(dead_code)]
    pub(crate) fn new(root_key: Zeroizing<[u8; 32]>, commitment: VaultCommitment) -> Self {
        Self {
            root_key,
            commitment,
        }
    }

    pub fn commitment(&self) -> VaultCommitment {
        self.commitment.clone()
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
        let session = VaultSession::new(Zeroizing::new([0x42; 32]), commitment.clone());
        assert!(session.commitment() == commitment);
    }
}
