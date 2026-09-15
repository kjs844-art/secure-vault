use vault_crypto::VaultSession;

fn assert_serialize<T: serde::Serialize>() {}

fn main() {
    assert_serialize::<VaultSession>();
}
