use vault_crypto::{PasswordEnvelopeStorageInspectionV1, VaultCommitment};

fn main() {
    let _ = PasswordEnvelopeStorageInspectionV1 {
        wire_version: 0,
        suite_id: 0,
        vault_commitment: VaultCommitment::from_bytes([0; 32]),
        envelope: &[],
    };
}
