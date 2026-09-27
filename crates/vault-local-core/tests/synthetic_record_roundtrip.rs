use vault_crypto::{MasterPassword, create_vault_v0alpha1, unlock_vault_v0alpha1};
use vault_local_core::{
    OpenCredentialOutcome, SyntheticCredentialFixtureId, open_credential_record_v1,
    seal_synthetic_fixture_v1,
};

#[test]
fn zero_one_and_multiple_connection_fixtures_survive_reunlock() {
    let password = MasterPassword::from_utf8("synthetic local core phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();

    let cases = [
        (SyntheticCredentialFixtureId::UnconnectedApiKey, 0, 1),
        (SyntheticCredentialFixtureId::SingleMcpConnection, 1, 1),
        (SyntheticCredentialFixtureId::MultipleConsumers, 3, 2),
    ];
    let records: Vec<_> = cases
        .iter()
        .map(|(fixture, _, _)| seal_synthetic_fixture_v1(&created.session, *fixture).unwrap())
        .collect();

    drop(created.session);
    let reopened = unlock_vault_v0alpha1(&password, &created.password_envelope).unwrap();

    for ((_, expected_connections, expected_fields), record) in cases.iter().zip(records.iter()) {
        let OpenCredentialOutcome::Current(opened) =
            open_credential_record_v1(&reopened, record).unwrap()
        else {
            panic!("current synthetic fixture unexpectedly requires upgrade");
        };
        assert_eq!(opened.item_name(), "Example Workshop API Credential");
        assert_eq!(opened.provider_name(), "Example AI Workshop");
        assert_eq!(opened.connection_count(), *expected_connections);
        assert_eq!(opened.secret_field_count(), *expected_fields);
        assert_eq!(opened.has_mcp_connection(), *expected_connections > 0);
    }
}
