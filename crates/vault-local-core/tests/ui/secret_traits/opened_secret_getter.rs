use vault_local_core::OpenedCredentialV1;

fn expose(opened: &OpenedCredentialV1) {
    let _ = opened.secret_value();
}

fn main() {}
