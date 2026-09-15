#![allow(
    dead_code,
    reason = "crate-private ID constructors and generation are consumed by later record tasks"
)]

use crate::LocalVaultError;

#[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RecordIdV1([u8; 16]);

#[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RevisionIdV1([u8; 32]);

#[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct EntityIdV1([u8; 16]);

pub(crate) struct RecordIdentityEntropy {
    pub record_id: RecordIdV1,
    pub revision_id: RevisionIdV1,
}

impl RecordIdV1 {
    pub(crate) const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

impl RevisionIdV1 {
    pub(crate) const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl EntityIdV1 {
    pub(crate) const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    pub(crate) const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

pub(crate) fn generate_record_identity() -> Result<RecordIdentityEntropy, LocalVaultError> {
    generate_record_identity_with(|block| {
        getrandom::fill(block).map_err(|_| LocalVaultError::RngUnavailable)
    })
}

fn generate_record_identity_with(
    mut fill: impl FnMut(&mut [u8]) -> Result<(), LocalVaultError>,
) -> Result<RecordIdentityEntropy, LocalVaultError> {
    let mut block = [0_u8; 48];
    fill(&mut block)?;
    Ok(record_identity_from_block(&block))
}

fn record_identity_from_block(block: &[u8; 48]) -> RecordIdentityEntropy {
    let mut record = [0_u8; 16];
    let mut revision = [0_u8; 32];
    record.copy_from_slice(&block[..16]);
    revision.copy_from_slice(&block[16..]);
    RecordIdentityEntropy {
        record_id: RecordIdV1(record),
        revision_id: RevisionIdV1(revision),
    }
}

#[cfg(test)]
mod tests {
    use super::generate_record_identity_with;
    use crate::{LocalVaultError, LocalVaultErrorCode};

    fn expect_error_code<T>(result: Result<T, LocalVaultError>) -> LocalVaultErrorCode {
        match result {
            Ok(_) => panic!("an expected synthetic entropy error was not returned"),
            Err(error) => error.code(),
        }
    }

    #[test]
    fn identity_generation_uses_one_draw_and_splits_the_block() {
        let mut calls = 0_u8;
        let identity = generate_record_identity_with(|block| {
            assert_eq!(block.len(), 48);
            calls += 1;
            for (index, byte) in block.iter_mut().enumerate() {
                *byte = u8::try_from(index).expect("the synthetic block index fits in u8");
            }
            Ok(())
        })
        .expect("synthetic entropy should produce an identity");

        assert_eq!(calls, 1);
        assert_eq!(
            identity.record_id.as_bytes(),
            &[
                0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
                0x0e, 0x0f
            ]
        );
        assert_eq!(
            identity.revision_id.as_bytes(),
            &[
                0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d,
                0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b,
                0x2c, 0x2d, 0x2e, 0x2f
            ]
        );
    }

    #[test]
    fn identity_generation_reports_one_failed_draw() {
        let mut calls = 0_u8;
        let result = generate_record_identity_with(|block| {
            assert_eq!(block.len(), 48);
            calls += 1;
            Err(LocalVaultError::RngUnavailable)
        });

        assert_eq!(
            expect_error_code(result),
            LocalVaultErrorCode::RngUnavailable
        );
        assert_eq!(calls, 1);
    }
}
