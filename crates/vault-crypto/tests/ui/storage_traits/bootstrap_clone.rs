use vault_crypto::PasswordEnvelopeBootstrapProjectionV1;

fn assert_clone<T: Clone>() {}

fn main() {
    assert_clone::<PasswordEnvelopeBootstrapProjectionV1<'static>>();
}
