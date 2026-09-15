use vault_crypto::{MasterPassword, create_vault_v0alpha1, unlock_vault_v0alpha1};
use vault_local_core::{
    OpenCredentialOutcome, SyntheticCredentialFixtureId, open_credential_record_v1,
    seal_synthetic_fixture_v1,
};

fn main() {
    let password = MasterPassword::from_utf8("synthetic example phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let record = seal_synthetic_fixture_v1(
        &created.session,
        SyntheticCredentialFixtureId::SingleMcpConnection,
    )
    .unwrap();
    drop(created.session);
    let reopened = unlock_vault_v0alpha1(&password, &created.password_envelope).unwrap();
    let OpenCredentialOutcome::Current(item) =
        open_credential_record_v1(&reopened, &record).unwrap()
    else {
        panic!("synthetic current fixture requires an unexpected upgrade");
    };

    println!("provider={}", item.provider_name());
    println!("connections={}", item.connection_count());
    println!("mcp_recorded={}", item.has_mcp_connection());
    println!("synthetic_only=true");
}
