use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use zeroize::{Zeroize, Zeroizing};

use crate::entropy::{EntropySource, OsEntropy, VaultCreationEntropy, with_vault_creation_entropy};
use crate::{CryptoError, MasterPassword, VaultCommitment, VaultSession};

use super::codec::{decode_password_envelope, encode_password_envelope, password_root_aad};
use super::kdf::with_candidate_password_kek;

const SALT_BYTES: usize = 16;
const COMMITMENT_BYTES: usize = 32;
const ROOT_KEY_BYTES: usize = 32;
const ROOT_NONCE_BYTES: usize = 24;

/// Result of creating one synthetic v0alpha1 vault.
pub struct CreatedVaultV0Alpha1 {
    pub password_envelope: Vec<u8>,
    pub session: VaultSession,
}

trait PasswordKdf {
    fn with_kek<T>(
        &mut self,
        password: &[u8],
        salt: &[u8; SALT_BYTES],
        operation: impl FnOnce(&[u8; ROOT_KEY_BYTES]) -> Result<T, CryptoError>,
    ) -> Result<T, CryptoError>;
}

struct CandidatePasswordKdf;

impl PasswordKdf for CandidatePasswordKdf {
    fn with_kek<T>(
        &mut self,
        password: &[u8],
        salt: &[u8; SALT_BYTES],
        operation: impl FnOnce(&[u8; ROOT_KEY_BYTES]) -> Result<T, CryptoError>,
    ) -> Result<T, CryptoError> {
        with_candidate_password_kek(password, salt, operation)
    }
}

/// Create a synthetic-only v0alpha1 vault root and its password envelope.
pub fn create_vault_v0alpha1(
    password: &MasterPassword,
) -> Result<CreatedVaultV0Alpha1, CryptoError> {
    let mut entropy = OsEntropy;
    let mut kdf = CandidatePasswordKdf;
    create_vault_with_dependencies(password, &mut entropy, &mut kdf)
}

/// Authenticate and unlock a synthetic-only v0alpha1 password envelope.
pub fn unlock_vault_v0alpha1(
    password: &MasterPassword,
    password_envelope: &[u8],
) -> Result<VaultSession, CryptoError> {
    unlock_vault_with_kdf(password, password_envelope, &mut CandidatePasswordKdf)
}

fn create_vault_with_dependencies(
    password: &MasterPassword,
    entropy: &mut impl EntropySource,
    kdf: &mut impl PasswordKdf,
) -> Result<CreatedVaultV0Alpha1, CryptoError> {
    with_vault_creation_entropy(entropy, |entropy| {
        let VaultCreationEntropy {
            salt,
            commitment,
            root_key,
            root_nonce,
        } = entropy;
        let aad = password_root_aad(&salt, &commitment)?;
        let wrapped_root = kdf.with_kek(password.expose_bytes(), &salt, |password_kek| {
            let cipher = XChaCha20Poly1305::new_from_slice(password_kek)
                .map_err(|_| CryptoError::InvalidLength)?;
            let nonce: &XNonce = (&root_nonce).into();
            cipher
                .encrypt(
                    nonce,
                    Payload {
                        msg: root_key.as_slice(),
                        aad: &aad,
                    },
                )
                .map_err(|_| CryptoError::AuthenticationFailed)
        })?;
        let password_envelope =
            encode_password_envelope(&salt, &commitment, &root_nonce, &wrapped_root)?;
        let session = VaultSession::new(root_key, VaultCommitment::from_bytes(commitment));

        Ok(CreatedVaultV0Alpha1 {
            password_envelope,
            session,
        })
    })
}

fn unlock_vault_with_kdf(
    password: &MasterPassword,
    password_envelope: &[u8],
    kdf: &mut impl PasswordKdf,
) -> Result<VaultSession, CryptoError> {
    // Strict decoding, header checks, fixed-length checks, and candidate-profile checks all
    // happen before the KDF boundary. Attacker-controlled cost fields never allocate memory.
    let fields = decode_password_envelope(password_envelope)?;
    let salt = copy_array::<SALT_BYTES>(fields.salt)?;
    let commitment = copy_array::<COMMITMENT_BYTES>(fields.vault_commitment)?;
    let root_nonce = copy_array::<ROOT_NONCE_BYTES>(fields.root_nonce)?;
    let aad = password_root_aad(&salt, &commitment)?;

    kdf.with_kek(password.expose_bytes(), &salt, |password_kek| {
        let cipher = XChaCha20Poly1305::new_from_slice(password_kek)
            .map_err(|_| CryptoError::InvalidLength)?;
        let nonce: &XNonce = (&root_nonce).into();
        let mut decrypted_root = Zeroizing::new(
            cipher
                .decrypt(
                    nonce,
                    Payload {
                        msg: fields.wrapped_root_key,
                        aad: &aad,
                    },
                )
                .map_err(|_| CryptoError::AuthenticationFailed)?,
        );
        if decrypted_root.len() != ROOT_KEY_BYTES {
            decrypted_root.zeroize();
            return Err(CryptoError::AuthenticationFailed);
        }

        let mut root_key = Zeroizing::new([0_u8; ROOT_KEY_BYTES]);
        root_key.copy_from_slice(&decrypted_root);
        decrypted_root.zeroize();

        Ok(VaultSession::new(
            root_key,
            VaultCommitment::from_bytes(commitment),
        ))
    })
}

fn copy_array<const N: usize>(input: &[u8]) -> Result<[u8; N], CryptoError> {
    input.try_into().map_err(|_| CryptoError::InvalidLength)
}

#[cfg(test)]
mod tests {
    use minicbor::Encoder;

    use super::*;
    use crate::{CryptoErrorCode, MasterPassword};

    struct CountingKdf {
        calls: usize,
    }

    impl PasswordKdf for CountingKdf {
        fn with_kek<T>(
            &mut self,
            _password: &[u8],
            _salt: &[u8; 16],
            operation: impl FnOnce(&[u8; 32]) -> Result<T, crate::CryptoError>,
        ) -> Result<T, crate::CryptoError> {
            self.calls += 1;
            let mut synthetic_key = Zeroizing::new([0x5a; 32]);
            let result = operation(&synthetic_key);
            synthetic_key.zeroize();
            result
        }
    }

    fn password_envelope_with_memory(memory_kib: u64) -> Vec<u8> {
        let mut encoder = Encoder::new(Vec::new());
        encoder.array(10).unwrap();
        encoder.u64(0).unwrap();
        encoder.u64(0xA101).unwrap();
        encoder.u64(1).unwrap();
        encoder.bytes(&[0x11; 16]).unwrap();
        encoder.u64(memory_kib).unwrap();
        encoder.u64(3).unwrap();
        encoder.u64(4).unwrap();
        encoder.bytes(&[0x22; 32]).unwrap();
        encoder.bytes(&[0x33; 24]).unwrap();
        encoder.bytes(&[0x44; 48]).unwrap();
        encoder.into_writer()
    }

    #[test]
    fn rejects_noncandidate_kdf_parameters_before_calling_argon2_boundary() {
        let password =
            MasterPassword::from_utf8("synthetic master phrase only".to_owned()).unwrap();
        let mut kdf = CountingKdf { calls: 0 };

        let error = match unlock_vault_with_kdf(
            &password,
            &password_envelope_with_memory(65_535),
            &mut kdf,
        ) {
            Ok(_) => panic!("a rejected synthetic KDF profile unexpectedly reached unlock"),
            Err(error) => error,
        };

        assert_eq!(error.code(), CryptoErrorCode::KdfParamsRejected);
        assert_eq!(kdf.calls, 0);
    }
}
