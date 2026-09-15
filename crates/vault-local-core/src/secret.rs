#![allow(
    dead_code,
    reason = "the crate-private secret wrapper is consumed by the next codec task"
)]

use zeroize::{Zeroize, Zeroizing};

use crate::LocalVaultError;

pub(crate) struct SecretValueV1(Zeroizing<Vec<u8>>);

impl SecretValueV1 {
    pub(crate) fn new(bytes: Vec<u8>) -> Result<Self, LocalVaultError> {
        if bytes.is_empty() {
            return Err(LocalVaultError::InvalidItem);
        }
        Ok(Self(Zeroizing::new(bytes)))
    }

    pub(crate) fn expose(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl Drop for SecretValueV1 {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
