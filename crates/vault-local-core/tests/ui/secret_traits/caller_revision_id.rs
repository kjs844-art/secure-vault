use vault_local_core::RevisionIdV1;

fn main() {
    let _ = RevisionIdV1::from_bytes([0_u8; 32]);
}
