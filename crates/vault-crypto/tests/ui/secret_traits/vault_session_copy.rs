use vault_crypto::VaultSession;

fn assert_copy<T: Copy>() {}

fn main() {
    assert_copy::<VaultSession>();
}
