use vault_crypto::MasterPassword;

fn assert_display<T: core::fmt::Display>() {}

fn main() {
    assert_display::<MasterPassword>();
}
