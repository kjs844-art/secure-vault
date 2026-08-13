use vault_crypto::SecretBytes;

fn assert_clone<T: Clone>() {}

fn main() {
    assert_clone::<SecretBytes>();
}
