use vault_crypto::SecretBytes;

fn assert_display<T: core::fmt::Display>() {}

fn main() {
    assert_display::<SecretBytes>();
}
