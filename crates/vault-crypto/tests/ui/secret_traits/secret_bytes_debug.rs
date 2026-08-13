use vault_crypto::SecretBytes;

fn assert_debug<T: core::fmt::Debug>() {}

fn main() {
    assert_debug::<SecretBytes>();
}
