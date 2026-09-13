use vault_client_bridge::{
    CLIENT_CATALOG_ENTRY_LIMIT_V1, CatalogConnectionTypeV1, CatalogCredentialStatusV1,
    CatalogCredentialTypeV1, ClientBridgeErrorCodeV1, ClientCatalogSnapshotV1,
    client_catalog_entry_count_is_supported_v1, project_authenticated_catalog_v1,
};
use vault_crypto::{MasterPassword, VaultSession, create_vault_v0alpha1};
use vault_local_core::{
    CredentialStorageAuthenticatorV1, OwnedRehydratedCredentialOutcomeV1,
    OwnedRehydratedCredentialV1, SyntheticCredentialFixtureId, create_synthetic_successor_v1,
    seal_synthetic_fixture_v1,
};

fn rehydrate_fixture(
    session: &VaultSession,
    fixture: SyntheticCredentialFixtureId,
) -> OwnedRehydratedCredentialV1 {
    let sealed = seal_synthetic_fixture_v1(session, fixture).unwrap();
    let persistence = sealed.persistence_projection_v1();
    let envelope = persistence.envelope().to_vec();
    rehydrate_envelope(session, envelope)
}

fn rehydrate_envelope(session: &VaultSession, envelope: Vec<u8>) -> OwnedRehydratedCredentialV1 {
    let authenticator = CredentialStorageAuthenticatorV1::new(session);
    let OwnedRehydratedCredentialOutcomeV1::Current(head) = authenticator
        .rehydrate_owned_stored_credential_v1(envelope)
        .unwrap()
    else {
        panic!("current synthetic fixture unexpectedly requires upgrade");
    };
    head
}

fn expect_error_code(
    result: Result<ClientCatalogSnapshotV1, vault_client_bridge::ClientBridgeErrorV1>,
) -> ClientBridgeErrorCodeV1 {
    match result {
        Ok(_) => panic!("an invalid catalog build unexpectedly succeeded"),
        Err(error) => error.code(),
    }
}

#[test]
fn client_catalog_limit_matches_the_storage_head_limit() {
    assert!(client_catalog_entry_count_is_supported_v1(0));
    assert!(client_catalog_entry_count_is_supported_v1(
        CLIENT_CATALOG_ENTRY_LIMIT_V1
    ));
    assert!(!client_catalog_entry_count_is_supported_v1(
        CLIENT_CATALOG_ENTRY_LIMIT_V1 + 1
    ));
    assert!(!client_catalog_entry_count_is_supported_v1(usize::MAX));
}

#[test]
fn oversized_authenticated_input_is_rejected_before_duplicate_or_decryption_work() {
    let password =
        MasterPassword::from_utf8("synthetic oversized catalog phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let sealed = seal_synthetic_fixture_v1(
        &created.session,
        SyntheticCredentialFixtureId::UnconnectedApiKey,
    )
    .unwrap();
    let envelope = sealed.persistence_projection_v1().envelope().to_vec();
    // Use one encrypted fixture and one password KDF; repeated authentication
    // supplies real owned heads without creating thousands of vaults or keys.
    let heads: Vec<_> = (0..=CLIENT_CATALOG_ENTRY_LIMIT_V1)
        .map(|_| rehydrate_envelope(&created.session, envelope.clone()))
        .collect();

    assert_eq!(heads.len(), CLIENT_CATALOG_ENTRY_LIMIT_V1 + 1);
    assert_eq!(
        expect_error_code(project_authenticated_catalog_v1(&created.session, &heads)),
        ClientBridgeErrorCodeV1::LimitsExceeded
    );
}

#[test]
fn authenticated_heads_become_an_ordered_secret_value_free_catalog() {
    let password = MasterPassword::from_utf8("synthetic client bridge phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let fixtures = [
        SyntheticCredentialFixtureId::UnconnectedApiKey,
        SyntheticCredentialFixtureId::SingleMcpConnection,
        SyntheticCredentialFixtureId::MultipleConsumers,
    ];
    let heads: Vec<_> = fixtures
        .into_iter()
        .map(|fixture| rehydrate_fixture(&created.session, fixture))
        .collect();

    let catalog = project_authenticated_catalog_v1(&created.session, &heads).unwrap();

    assert_eq!(catalog.len(), 3);
    assert!(!catalog.is_empty());
    for reference in 0_u32..3 {
        let entry = catalog
            .entry(reference)
            .expect("every fixture has one entry");
        assert_eq!(entry.reference(), reference);
        assert!(entry.item_name() == "Example Workshop API Credential");
        assert!(entry.provider_name() == "Example AI Workshop");
        assert!(entry.credential_type() == CatalogCredentialTypeV1::ApiKey);
        assert!(entry.status() == CatalogCredentialStatusV1::Active);
        assert!(entry.connection(entry.connection_count()).is_none());
        assert!(entry.connection(usize::MAX).is_none());
        let expected = [
            (CatalogConnectionTypeV1::McpServer, "Example MCP"),
            (CatalogConnectionTypeV1::Cli, "Example CLI"),
            (CatalogConnectionTypeV1::CiCd, "Example CI"),
        ];
        for (index, (consumer_type, label)) in expected
            .into_iter()
            .take(entry.connection_count())
            .enumerate()
        {
            let connection = entry.connection(index).unwrap();
            assert!(connection.consumer_type() == consumer_type);
            assert_eq!(connection.label(), label);
        }
    }
    assert_eq!(catalog.entry(0).unwrap().connection_count(), 0);
    assert_eq!(catalog.entry(1).unwrap().connection_count(), 1);
    assert_eq!(catalog.entry(2).unwrap().connection_count(), 3);
    assert_eq!(catalog.entry(0).unwrap().mcp_connection_count(), 0);
    assert_eq!(catalog.entry(1).unwrap().mcp_connection_count(), 1);
    assert_eq!(catalog.entry(2).unwrap().mcp_connection_count(), 1);
    assert!(catalog.entry(3).is_none());
    assert!(catalog.entry(u32::MAX).is_none());
}

#[test]
fn a_valid_head_followed_by_another_vault_head_returns_no_partial_catalog() {
    let password = MasterPassword::from_utf8("synthetic bridge vault phrase".to_owned()).unwrap();
    let first = create_vault_v0alpha1(&password).unwrap();
    let second = create_vault_v0alpha1(&password).unwrap();
    let valid_head = rehydrate_fixture(
        &first.session,
        SyntheticCredentialFixtureId::SingleMcpConnection,
    );
    let foreign_head = rehydrate_fixture(
        &second.session,
        SyntheticCredentialFixtureId::UnconnectedApiKey,
    );

    assert_eq!(
        expect_error_code(project_authenticated_catalog_v1(
            &first.session,
            &[valid_head, foreign_head],
        )),
        ClientBridgeErrorCodeV1::AuthenticationFailed
    );
}

#[test]
fn an_empty_catalog_has_no_valid_references() {
    let password = MasterPassword::from_utf8("synthetic empty catalog phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();

    let catalog = project_authenticated_catalog_v1(&created.session, &[]).unwrap();

    assert!(catalog.is_empty());
    assert_eq!(catalog.len(), 0);
    assert!(catalog.entry(0).is_none());
    assert!(catalog.entry(u32::MAX).is_none());
}

#[test]
fn a_repeated_authenticated_head_is_rejected_before_session_decryption() {
    let password = MasterPassword::from_utf8("synthetic duplicate head phrase".to_owned()).unwrap();
    let first = create_vault_v0alpha1(&password).unwrap();
    let second = create_vault_v0alpha1(&password).unwrap();
    let sealed = seal_synthetic_fixture_v1(
        &first.session,
        SyntheticCredentialFixtureId::UnconnectedApiKey,
    )
    .unwrap();
    let envelope = sealed.persistence_projection_v1().envelope().to_vec();
    let heads = [
        rehydrate_envelope(&first.session, envelope.clone()),
        rehydrate_envelope(&first.session, envelope),
    ];

    assert_eq!(
        expect_error_code(project_authenticated_catalog_v1(&first.session, &heads)),
        ClientBridgeErrorCodeV1::InvalidItem
    );
    // With no duplicate preflight, opening the first row under this unrelated
    // session would instead fail authentication. InvalidItem pins the order.
    assert_eq!(
        expect_error_code(project_authenticated_catalog_v1(&second.session, &heads)),
        ClientBridgeErrorCodeV1::InvalidItem
    );
}

#[test]
fn different_revisions_of_one_record_are_not_accepted_as_separate_rows() {
    let password =
        MasterPassword::from_utf8("synthetic revision catalog phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let sealed = seal_synthetic_fixture_v1(
        &created.session,
        SyntheticCredentialFixtureId::SingleMcpConnection,
    )
    .unwrap();
    let successor = create_synthetic_successor_v1(&created.session, &sealed).unwrap();
    let predecessor_projection = sealed.persistence_projection_v1();
    let successor_projection = successor.persistence_projection_v1();
    assert!(predecessor_projection.record_id() == successor_projection.record_id());
    assert!(predecessor_projection.revision_id() != successor_projection.revision_id());
    let mut heads = [
        rehydrate_envelope(&created.session, predecessor_projection.envelope().to_vec()),
        rehydrate_envelope(&created.session, successor_projection.envelope().to_vec()),
    ];

    // Neither first-wins nor last-wins revision selection is permitted.
    for _ in 0..2 {
        assert_eq!(
            expect_error_code(project_authenticated_catalog_v1(&created.session, &heads)),
            ClientBridgeErrorCodeV1::InvalidItem
        );
        heads.reverse();
    }
}
