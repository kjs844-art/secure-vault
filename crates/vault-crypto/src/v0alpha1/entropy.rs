use zeroize::Zeroizing;

use crate::{CryptoError, secret::HeapSecretKey};

const VAULT_CREATION_ENTROPY_BYTES: usize = 104;
const RECORD_SEALING_ENTROPY_BYTES: usize = 80;

pub(crate) trait EntropySource {
    fn fill(&mut self, destination: &mut [u8]) -> Result<(), CryptoError>;
}

pub(crate) struct OsEntropy;

impl EntropySource for OsEntropy {
    fn fill(&mut self, destination: &mut [u8]) -> Result<(), CryptoError> {
        getrandom::fill(destination).map_err(|_| CryptoError::RngUnavailable)
    }
}

pub(crate) struct VaultCreationEntropy {
    pub(crate) salt: [u8; 16],
    pub(crate) commitment: [u8; 32],
    pub(crate) root_key: HeapSecretKey,
    pub(crate) root_nonce: [u8; 24],
}

pub(crate) struct RecordSealingEntropy {
    pub(crate) item_dek: HeapSecretKey,
    pub(crate) item_key_nonce: [u8; 24],
    pub(crate) body_nonce: [u8; 24],
}

pub(crate) fn with_vault_creation_entropy<T>(
    source: &mut impl EntropySource,
    operation: impl FnOnce(VaultCreationEntropy) -> Result<T, CryptoError>,
) -> Result<T, CryptoError> {
    let mut block = Zeroizing::new([0_u8; VAULT_CREATION_ENTROPY_BYTES]);
    source.fill(block.as_mut())?;

    let root_key = HeapSecretKey::copy_from_zeroizing_block(&block, 48..80)?;
    operation(VaultCreationEntropy {
        salt: copy_array(&block[0..16]),
        commitment: copy_array(&block[16..48]),
        root_key,
        root_nonce: copy_array(&block[80..104]),
    })
}

pub(crate) fn with_record_sealing_entropy<T>(
    source: &mut impl EntropySource,
    operation: impl FnOnce(RecordSealingEntropy) -> Result<T, CryptoError>,
) -> Result<T, CryptoError> {
    let mut block = Zeroizing::new([0_u8; RECORD_SEALING_ENTROPY_BYTES]);
    source.fill(block.as_mut())?;

    let item_dek = HeapSecretKey::copy_from_zeroizing_block(&block, 0..32)?;
    operation(RecordSealingEntropy {
        item_dek,
        item_key_nonce: copy_array(&block[32..56]),
        body_nonce: copy_array(&block[56..80]),
    })
}

fn copy_array<const N: usize>(input: &[u8]) -> [u8; N] {
    let mut output = [0_u8; N];
    output.copy_from_slice(input);
    output
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;
    use crate::CryptoErrorCode;

    struct DeterministicEntropy {
        bytes: Vec<u8>,
        offset: usize,
        calls: usize,
        requested_lengths: Vec<usize>,
    }

    impl DeterministicEntropy {
        fn new(bytes: Vec<u8>) -> Self {
            Self {
                bytes,
                offset: 0,
                calls: 0,
                requested_lengths: Vec::new(),
            }
        }
    }

    impl EntropySource for DeterministicEntropy {
        fn fill(&mut self, destination: &mut [u8]) -> Result<(), crate::CryptoError> {
            self.calls += 1;
            self.requested_lengths.push(destination.len());
            let end = self.offset + destination.len();
            if end > self.bytes.len() {
                return Err(crate::CryptoError::RngUnavailable);
            }
            destination.copy_from_slice(&self.bytes[self.offset..end]);
            self.offset = end;
            Ok(())
        }
    }

    struct FailingEntropy {
        calls: usize,
    }

    impl EntropySource for FailingEntropy {
        fn fill(&mut self, destination: &mut [u8]) -> Result<(), crate::CryptoError> {
            self.calls += 1;
            if let Some(first) = destination.first_mut() {
                *first = 0xa5;
            }
            Err(crate::CryptoError::RngUnavailable)
        }
    }

    #[test]
    fn vault_creation_consumes_one_exact_104_byte_block() {
        let input: Vec<u8> = (0_u8..104).collect();
        let mut source = DeterministicEntropy::new(input);

        with_vault_creation_entropy(&mut source, |entropy| {
            assert_eq!(entropy.salt.as_slice(), (0_u8..16).collect::<Vec<_>>());
            assert_eq!(
                entropy.commitment.as_slice(),
                (16_u8..48).collect::<Vec<_>>()
            );
            assert!(
                entropy
                    .root_key
                    .matches_bytes(&(48_u8..80).collect::<Vec<_>>())
            );
            assert_eq!(
                entropy.root_nonce.as_slice(),
                (80_u8..104).collect::<Vec<_>>()
            );
            Ok(())
        })
        .unwrap();

        assert_eq!(source.calls, 1);
        assert_eq!(source.requested_lengths, [104]);
        assert_eq!(source.offset, 104);
    }

    #[test]
    fn record_sealing_consumes_one_exact_80_byte_block() {
        let input: Vec<u8> = (0x80_u8..=0xcf).collect();
        let mut source = DeterministicEntropy::new(input);

        with_record_sealing_entropy(&mut source, |entropy| {
            assert!(
                entropy
                    .item_dek
                    .matches_bytes(&(0x80_u8..0xa0).collect::<Vec<_>>())
            );
            assert_eq!(
                entropy.item_key_nonce.as_slice(),
                (0xa0_u8..0xb8).collect::<Vec<_>>()
            );
            assert_eq!(
                entropy.body_nonce.as_slice(),
                (0xb8_u8..=0xcf).collect::<Vec<_>>()
            );
            Ok(())
        })
        .unwrap();

        assert_eq!(source.calls, 1);
        assert_eq!(source.requested_lengths, [80]);
        assert_eq!(source.offset, 80);
    }

    #[test]
    fn root_and_item_keys_keep_heap_storage_across_owner_moves() {
        let mut vault_source = DeterministicEntropy::new((0_u8..104).collect());
        with_vault_creation_entropy(&mut vault_source, |entropy| {
            assert_eq!(
                std::mem::size_of_val(&entropy.root_key),
                std::mem::size_of::<usize>(),
                "the root-key owner must be pointer-sized heap ownership"
            );
            let storage_before_move = entropy.root_key.allocation_address();
            let moved_root_key = entropy.root_key;
            assert_eq!(moved_root_key.allocation_address(), storage_before_move);
            Ok(())
        })
        .unwrap();

        let mut record_source = DeterministicEntropy::new((0x80_u8..=0xcf).collect::<Vec<_>>());
        with_record_sealing_entropy(&mut record_source, |entropy| {
            assert_eq!(
                std::mem::size_of_val(&entropy.item_dek),
                std::mem::size_of::<usize>(),
                "the Item DEK owner must be pointer-sized heap ownership"
            );
            let storage_before_move = entropy.item_dek.allocation_address();
            let moved_item_dek = entropy.item_dek;
            assert_eq!(moved_item_dek.allocation_address(), storage_before_move);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn failed_vault_entropy_never_runs_the_following_crypto_operation() {
        let operation_calls = Cell::new(0);
        let mut source = FailingEntropy { calls: 0 };

        let result = with_vault_creation_entropy(&mut source, |_| {
            operation_calls.set(operation_calls.get() + 1);
            Ok(())
        });

        assert_eq!(result.unwrap_err().code(), CryptoErrorCode::RngUnavailable);
        assert_eq!(source.calls, 1);
        assert_eq!(operation_calls.get(), 0);
    }

    #[test]
    fn failed_record_entropy_never_runs_the_following_crypto_operation() {
        let operation_calls = Cell::new(0);
        let mut source = FailingEntropy { calls: 0 };

        let result = with_record_sealing_entropy(&mut source, |_| {
            operation_calls.set(operation_calls.get() + 1);
            Ok(())
        });

        assert_eq!(result.unwrap_err().code(), CryptoErrorCode::RngUnavailable);
        assert_eq!(source.calls, 1);
        assert_eq!(operation_calls.get(), 0);
    }
}
