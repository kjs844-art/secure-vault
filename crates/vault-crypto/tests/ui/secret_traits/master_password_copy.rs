use vault_crypto::MasterPassword;

fn assert_copy<T: Copy>() {}

fn main() {
    assert_copy::<MasterPassword>();
}
