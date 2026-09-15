use vault_crypto::SecretBytes;

fn assert_serialize<T: serde::Serialize>() {}

fn main() {
    assert_serialize::<SecretBytes>();
}
