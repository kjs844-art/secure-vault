use argon2::{Algorithm, Argon2, AssociatedData, Block, ParamsBuilder, Version};
use zeroize::{Zeroize, Zeroizing};

use crate::CryptoError;

pub(crate) const CANDIDATE_MEMORY_KIB: u32 = 65_536;
pub(crate) const CANDIDATE_TIME_COST: u32 = 3;
pub(crate) const CANDIDATE_LANES: u32 = 4;

const PASSWORD_KEK_BYTES: usize = 32;

#[derive(Clone, Copy)]
struct KdfProfile {
    memory_kib: u32,
    time_cost: u32,
    lanes: u32,
}

pub(crate) fn with_candidate_password_kek<T>(
    password: &[u8],
    salt: &[u8; 16],
    operation: impl FnOnce(&[u8; PASSWORD_KEK_BYTES]) -> Result<T, CryptoError>,
) -> Result<T, CryptoError> {
    with_argon2id_output(
        password,
        salt,
        &[],
        &[],
        KdfProfile {
            memory_kib: CANDIDATE_MEMORY_KIB,
            time_cost: CANDIDATE_TIME_COST,
            lanes: CANDIDATE_LANES,
        },
        operation,
    )
}

fn with_argon2id_output<T>(
    password: &[u8],
    salt: &[u8],
    secret: &[u8],
    associated_data: &[u8],
    profile: KdfProfile,
    operation: impl FnOnce(&[u8; PASSWORD_KEK_BYTES]) -> Result<T, CryptoError>,
) -> Result<T, CryptoError> {
    let associated_data =
        AssociatedData::new(associated_data).map_err(|_| CryptoError::KdfParamsRejected)?;
    let params = ParamsBuilder::new()
        .m_cost(profile.memory_kib)
        .t_cost(profile.time_cost)
        .p_cost(profile.lanes)
        .data(associated_data)
        .output_len(PASSWORD_KEK_BYTES)
        .build()
        .map_err(|_| CryptoError::KdfParamsRejected)?;
    let block_count = params.block_count();
    let argon2 = Argon2::new_with_secret(secret, Algorithm::Argon2id, Version::V0x13, params)
        .map_err(|_| CryptoError::KdfParamsRejected)?;

    let mut working_memory = Zeroizing::new(vec![Block::default(); block_count]);
    let mut output = Zeroizing::new([0_u8; PASSWORD_KEK_BYTES]);
    let hash_result = argon2.hash_password_into_with_memory(
        password,
        salt,
        output.as_mut(),
        working_memory.as_mut_slice(),
    );

    working_memory.zeroize();
    if hash_result.is_err() {
        output.zeroize();
        return Err(CryptoError::KdfParamsRejected);
    }

    let operation_result = operation(&output);
    output.zeroize();
    operation_result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_rfc_9106_argon2id_v13_known_answer() {
        let password = [0x01; 32];
        let salt = [0x02; 16];
        let secret = [0x03; 8];
        let associated_data = [0x04; 12];
        let expected = [
            0x0d, 0x64, 0x0d, 0xf5, 0x8d, 0x78, 0x76, 0x6c, 0x08, 0xc0, 0x37, 0xa3, 0x4a, 0x8b,
            0x53, 0xc9, 0xd0, 0x1e, 0xf0, 0x45, 0x2d, 0x75, 0xb6, 0x5e, 0xb5, 0x25, 0x20, 0xe9,
            0x6b, 0x01, 0xe6, 0x59,
        ];

        with_argon2id_output(
            &password,
            &salt,
            &secret,
            &associated_data,
            KdfProfile {
                memory_kib: 32,
                time_cost: 3,
                lanes: 4,
            },
            |actual| {
                assert_eq!(actual, &expected);
                Ok(())
            },
        )
        .unwrap();
    }
}
