use vault_crypto::MasterPassword;

fn assert_debug<T: core::fmt::Debug>() {}

fn main() {
    assert_debug::<MasterPassword>();
}
