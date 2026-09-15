use vault_crypto::VaultSession;

fn assert_clone<T: Clone>() {}

fn main() {
    assert_clone::<VaultSession>();
}
