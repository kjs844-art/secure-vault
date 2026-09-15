use vault_crypto::VaultSession;

fn expose_root_key(session: &VaultSession) {
    let _ = session.root_key_bytes();
}

fn main() {}
