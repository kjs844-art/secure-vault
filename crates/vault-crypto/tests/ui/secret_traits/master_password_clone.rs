use vault_crypto::MasterPassword;

fn assert_clone<T: Clone>() {}

fn main() {
    assert_clone::<MasterPassword>();
}
