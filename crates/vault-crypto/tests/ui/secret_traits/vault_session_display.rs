use vault_crypto::VaultSession;

fn assert_display<T: core::fmt::Display>() {}

fn main() {
    assert_display::<VaultSession>();
}
