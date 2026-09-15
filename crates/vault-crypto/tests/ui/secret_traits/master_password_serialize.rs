use vault_crypto::MasterPassword;

fn assert_serialize<T: serde::Serialize>() {}

fn main() {
    assert_serialize::<MasterPassword>();
}
