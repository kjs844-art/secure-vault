use vault_local_core::RecordIdV1;

fn main() {
    let _ = RecordIdV1::from_bytes([0_u8; 16]);
}
