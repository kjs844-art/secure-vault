use vault_local_core::OpenedCredentialV1;

fn require_copy<T: Copy>() {}

fn main() {
    require_copy::<OpenedCredentialV1>();
}
