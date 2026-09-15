use vault_crypto::{MasterPassword, create_vault_v0alpha1};
use vault_local_core::{
    CatalogConnectionTypeV1, CatalogCredentialStatusV1, CatalogCredentialTypeV1,
    OpenCredentialOutcome, SyntheticCredentialFixtureId, open_credential_record_v1,
    seal_synthetic_fixture_v1,
};

#[test]
fn opened_credentials_consume_into_non_secret_catalog_projections() {
    let password =
        MasterPassword::from_utf8("synthetic catalog projection phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let cases = [
        (SyntheticCredentialFixtureId::UnconnectedApiKey, 0, 1, 0),
        (SyntheticCredentialFixtureId::SingleMcpConnection, 1, 1, 1),
        (SyntheticCredentialFixtureId::MultipleConsumers, 3, 2, 1),
    ];

    for (fixture, expected_connections, expected_fields, expected_mcp_connections) in cases {
        let sealed = seal_synthetic_fixture_v1(&created.session, fixture).unwrap();
        let persistence = sealed.persistence_projection_v1();
        let expected_record_id = persistence.record_id();
        let expected_revision_id = persistence.revision_id();
        let OpenCredentialOutcome::Current(opened) =
            open_credential_record_v1(&created.session, &sealed).unwrap()
        else {
            panic!("current synthetic fixture unexpectedly requires upgrade");
        };

        let projection = opened.into_catalog_projection_v1();

        assert!(projection.record_id() == expected_record_id);
        assert!(projection.revision_id() == expected_revision_id);
        assert_eq!(projection.item_name(), "Example Workshop API Credential");
        assert_eq!(projection.provider_name(), "Example AI Workshop");
        assert!(projection.issuer_account_identifier() == Some("demo-account"));
        assert!(projection.issuer_organization_or_workspace().is_none());
        assert!(projection.issuer_project() == Some("demo-project"));
        assert!(projection.issuer_environment() == Some("demo"));
        assert!(projection.credential_type() == CatalogCredentialTypeV1::ApiKey);
        assert!(projection.status() == CatalogCredentialStatusV1::Active);
        assert_eq!(projection.connection_count(), expected_connections);
        assert_eq!(projection.secret_field_count(), expected_fields);
        assert_eq!(projection.mcp_connection_count(), expected_mcp_connections);
        assert!(projection.connection(expected_connections).is_none());
        assert!(projection.connection(usize::MAX).is_none());

        let expected = [
            (CatalogConnectionTypeV1::McpServer, "Example MCP"),
            (CatalogConnectionTypeV1::Cli, "Example CLI"),
            (CatalogConnectionTypeV1::CiCd, "Example CI"),
        ];
        for (index, (consumer_type, label)) in
            expected.into_iter().take(expected_connections).enumerate()
        {
            let connection = projection.connection(index).unwrap();
            assert!(connection.consumer_type() == consumer_type);
            assert_eq!(connection.label(), label);
        }
    }
}
