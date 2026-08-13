use vault_crypto::SecretBytes;

fn assert_copy<T: Copy>() {}

fn main() {
    assert_copy::<SecretBytes>();
}
