use vault_crypto::VaultSession;

fn assert_debug<T: core::fmt::Debug>() {}

fn main() {
    assert_debug::<VaultSession>();
}
