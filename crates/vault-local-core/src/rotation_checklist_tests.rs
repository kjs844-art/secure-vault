//! Sanitized synthetic rotation-checklist boundary tests.

use vault_crypto::{MasterPassword, VaultSession, create_vault_v0alpha1};

use super::*;
use crate::model::{
    ConnectionStatusV1, ConsumerTypeV1, ExternalRevocationAttestationV1,
    ExternalRevocationStatusV1, RotationStateV1,
};
use crate::record::{seal_item_v1, sealed_from_current_envelope};
use crate::rotation::{
    SyntheticRotationCutoverSelectionV1, SyntheticVerificationEvidenceV1,
    create_synthetic_rotation_cutover_successor_v1,
};
use crate::synthetic::build_synthetic_fixture_v1;
use crate::{
    LocalVaultErrorCode, RecordIdV1, RevisionIdV1, StoredPaddingBucketV0Alpha1,
    SyntheticCredentialFixtureId, seal_synthetic_fixture_v1,
};

fn session(phrase: &str) -> VaultSession {
    let password = MasterPassword::from_utf8(phrase.to_owned()).unwrap();
    create_vault_v0alpha1(&password).unwrap().session
}

fn record_from_successor(
    successor: &crate::SyntheticCredentialSuccessorV1,
) -> SealedCredentialRecordV0Alpha1 {
    sealed_from_current_envelope(successor.persistence_projection_v1().envelope().to_vec()).unwrap()
}

fn empty_cutover(
    session: &VaultSession,
    predecessor: &SealedCredentialRecordV0Alpha1,
) -> SealedCredentialRecordV0Alpha1 {
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let successor =
        create_synthetic_rotation_cutover_successor_v1(session, predecessor, &selection).unwrap();
    record_from_successor(&successor)
}

fn error_code(
    result: Result<SyntheticRotationChecklistV1, LocalVaultError>,
) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("invalid checklist source was accepted"),
        Err(error) => error.code(),
    }
}

#[test]
fn zero_one_and_three_connection_heads_project_closed_entries_in_payload_order() {
    let session = session("DEMO_VALUE_ONLY_checklist_counts");
    let zero = seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
        .unwrap();
    let zero = inspect_synthetic_rotation_checklist_v1(&session, &zero).unwrap();
    assert!(zero.entries().is_empty());

    let one =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::SingleMcpConnection)
            .unwrap();
    let one = inspect_synthetic_rotation_checklist_v1(&session, &one).unwrap();
    assert_eq!(one.entries().len(), 1);
    assert!(one.entries()[0].fixture() == SyntheticRotationChecklistFixtureV1::Mcp);
    assert!(one.entries()[0].required_for_cutover());

    let mut three =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    three.connections.swap(0, 2);
    three.connections[0].required_for_cutover = true;
    three.connections[1].required_for_cutover = false;
    three.connections[2].required_for_cutover = true;
    let three = seal_item_v1(&session, three).unwrap();
    let three = inspect_synthetic_rotation_checklist_v1(&session, &three).unwrap();
    assert_eq!(three.entries().len(), 3);
    assert!(three.entries()[0].fixture() == SyntheticRotationChecklistFixtureV1::Ci);
    assert!(three.entries()[0].required_for_cutover());
    assert!(three.entries()[1].fixture() == SyntheticRotationChecklistFixtureV1::Cli);
    assert!(!three.entries()[1].required_for_cutover());
    assert!(three.entries()[2].fixture() == SyntheticRotationChecklistFixtureV1::Mcp);
    assert!(three.entries()[2].required_for_cutover());
}

#[test]
fn removed_connections_are_validated_but_excluded_without_reordering_survivors() {
    let session = session("DEMO_VALUE_ONLY_checklist_removed");
    let mut item =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    item.connections[1].status = ConnectionStatusV1::Removed;
    item.connections[1].required_for_cutover = true;
    item.connections[2].required_for_cutover = true;
    let sealed = seal_item_v1(&session, item).unwrap();
    let checklist = inspect_synthetic_rotation_checklist_v1(&session, &sealed).unwrap();
    assert_eq!(checklist.entries().len(), 2);
    assert!(checklist.entries()[0].fixture() == SyntheticRotationChecklistFixtureV1::Mcp);
    assert!(checklist.entries()[1].fixture() == SyntheticRotationChecklistFixtureV1::Ci);
    assert!(checklist.entries()[1].required_for_cutover());

    let mut malformed =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    malformed.connections[1].status = ConnectionStatusV1::Removed;
    malformed.connections[1].consumer_name = "DEMO_VALUE_ONLY_unknown_removed".to_owned();
    let malformed = seal_item_v1(&session, malformed).unwrap();
    assert_eq!(
        error_code(inspect_synthetic_rotation_checklist_v1(
            &session, &malformed
        )),
        LocalVaultErrorCode::InvalidItem
    );
}

#[test]
fn unknown_status_unknown_fixture_and_duplicate_fixture_fail_closed() {
    let session = session("DEMO_VALUE_ONLY_checklist_invalid_connections");

    let mut unknown_status =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::SingleMcpConnection).unwrap();
    unknown_status.connections[0].status = ConnectionStatusV1::Unknown;
    let unknown_status = seal_item_v1(&session, unknown_status).unwrap();
    assert_eq!(
        error_code(inspect_synthetic_rotation_checklist_v1(
            &session,
            &unknown_status
        )),
        LocalVaultErrorCode::InvalidItem
    );

    let mut unknown_fixture =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    unknown_fixture.connections[2].consumer_type = ConsumerTypeV1::Custom;
    unknown_fixture.connections[2].consumer_name = "DEMO_VALUE_ONLY_unknown".to_owned();
    let unknown_fixture = seal_item_v1(&session, unknown_fixture).unwrap();
    assert_eq!(
        error_code(inspect_synthetic_rotation_checklist_v1(
            &session,
            &unknown_fixture
        )),
        LocalVaultErrorCode::InvalidItem
    );

    let mut duplicate =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    duplicate.connections[2].consumer_type = ConsumerTypeV1::Cli;
    duplicate.connections[2].consumer_name = "Example CLI".to_owned();
    let duplicate = seal_item_v1(&session, duplicate).unwrap();
    assert_eq!(
        error_code(inspect_synthetic_rotation_checklist_v1(
            &session, &duplicate
        )),
        LocalVaultErrorCode::InvalidItem
    );

    let mut removed_duplicate =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    removed_duplicate.connections[2].consumer_type = ConsumerTypeV1::Cli;
    removed_duplicate.connections[2].consumer_name = "Example CLI".to_owned();
    removed_duplicate.connections[2].status = ConnectionStatusV1::Removed;
    let removed_duplicate = seal_item_v1(&session, removed_duplicate).unwrap();
    assert_eq!(
        error_code(inspect_synthetic_rotation_checklist_v1(
            &session,
            &removed_duplicate
        )),
        LocalVaultErrorCode::InvalidItem
    );
}

#[test]
fn generation_projection_covers_initial_rotated_and_terminal_without_secret_access() {
    let session = session("DEMO_VALUE_ONLY_checklist_generations");
    let initial =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    let initial_view = inspect_synthetic_rotation_checklist_v1(&session, &initial).unwrap();
    assert!(initial_view.generation() == SyntheticRotationChecklistGenerationV1::Initial0001);

    let rotated = empty_cutover(&session, &initial);
    let rotated_view = inspect_synthetic_rotation_checklist_v1(&session, &rotated).unwrap();
    assert!(rotated_view.generation() == SyntheticRotationChecklistGenerationV1::Rotated0002);

    let terminal = empty_cutover(&session, &rotated);
    let terminal_view = inspect_synthetic_rotation_checklist_v1(&session, &terminal).unwrap();
    assert!(terminal_view.generation() == SyntheticRotationChecklistGenerationV1::Terminal0003);
    assert!(terminal_view.entries().is_empty());
}

#[test]
fn nonempty_rotated_and_terminal_heads_preserve_only_safe_checklist_entries() {
    let session = session("DEMO_VALUE_ONLY_checklist_nonempty_generations");
    let mut item =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    item.connections[0].required_for_cutover = true;
    let initial = seal_item_v1(&session, item).unwrap();

    let first_selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0],
        &[1],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let rotated = record_from_successor(
        &create_synthetic_rotation_cutover_successor_v1(&session, &initial, &first_selection)
            .unwrap(),
    );
    let rotated_view = inspect_synthetic_rotation_checklist_v1(&session, &rotated).unwrap();
    assert!(rotated_view.generation() == SyntheticRotationChecklistGenerationV1::Rotated0002);
    assert_safe_three_entry_projection(&rotated_view);

    let second_selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[0],
        SyntheticVerificationEvidenceV1::ProviderVerified,
    )
    .unwrap();
    let terminal = record_from_successor(
        &create_synthetic_rotation_cutover_successor_v1(&session, &rotated, &second_selection)
            .unwrap(),
    );
    let terminal_view = inspect_synthetic_rotation_checklist_v1(&session, &terminal).unwrap();
    assert!(terminal_view.generation() == SyntheticRotationChecklistGenerationV1::Terminal0003);
    assert_safe_three_entry_projection(&terminal_view);
}

fn assert_safe_three_entry_projection(checklist: &SyntheticRotationChecklistV1) {
    assert_eq!(checklist.entries().len(), 3);
    assert!(checklist.entries()[0].fixture() == SyntheticRotationChecklistFixtureV1::Mcp);
    assert!(checklist.entries()[0].required_for_cutover());
    assert!(checklist.entries()[1].fixture() == SyntheticRotationChecklistFixtureV1::Cli);
    assert!(!checklist.entries()[1].required_for_cutover());
    assert!(checklist.entries()[2].fixture() == SyntheticRotationChecklistFixtureV1::Ci);
    assert!(!checklist.entries()[2].required_for_cutover());
}

#[test]
fn incomplete_rotation_lifecycle_evidence_is_not_projected_as_a_checklist() {
    let session = session("DEMO_VALUE_ONLY_checklist_incomplete_lifecycle");
    let mut item =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::SingleMcpConnection).unwrap();
    let parent = RevisionIdV1::from_bytes([0x53; 32]);
    let connection_id = item.connections[0].connection_id;
    item.parent_revision_id = Some(parent);
    item.rotation_state = Some(RotationStateV1 {
        supersedes_revision_id: parent,
        required_connection_ids: vec![connection_id],
        completed_connection_ids: vec![],
        superseded_external_revocation_status: ExternalRevocationStatusV1::NotRequested,
        superseded_external_revocation_attestation: ExternalRevocationAttestationV1::None,
        superseded_revoked_at: None,
    });
    let incomplete = seal_item_v1(&session, item).unwrap();

    assert_eq!(
        error_code(inspect_synthetic_rotation_checklist_v1(
            &session,
            &incomplete
        )),
        LocalVaultErrorCode::InvalidItem
    );
}

#[test]
fn wrong_session_ciphertext_tamper_and_future_inner_fail_closed_without_mutation() {
    let current = session("DEMO_VALUE_ONLY_checklist_authentication");
    let other = session("DEMO_VALUE_ONLY_checklist_other_session");
    let original =
        seal_synthetic_fixture_v1(&current, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    let original_bytes = original.envelope.clone();
    assert_eq!(
        error_code(inspect_synthetic_rotation_checklist_v1(&other, &original)),
        LocalVaultErrorCode::AuthenticationFailed
    );
    assert!(original.envelope == original_bytes);

    let mut tampered =
        seal_synthetic_fixture_v1(&current, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    *tampered.envelope.last_mut().unwrap() ^= 1;
    let tampered_bytes = tampered.envelope.clone();
    assert_eq!(
        error_code(inspect_synthetic_rotation_checklist_v1(&current, &tampered)),
        LocalVaultErrorCode::AuthenticationFailed
    );
    assert!(tampered.envelope == tampered_bytes);

    let future = crate::record::seal_synthetic_future_inner_v2(&current).unwrap();
    let future_bytes = future.envelope.clone();
    assert!(inspect_synthetic_rotation_checklist_v1(&current, &future).is_err());
    assert!(future.envelope == future_bytes);
}

#[test]
fn cached_locator_mutation_cannot_redirect_authenticated_checklist() {
    let session = session("DEMO_VALUE_ONLY_checklist_locator");
    let mut record =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::SingleMcpConnection)
            .unwrap();
    let before = record.envelope.clone();
    record.locator.record_id = RecordIdV1::from_bytes([0x91; 16]);
    record.locator.revision_id = RevisionIdV1::from_bytes([0x92; 32]);
    record.locator.key_epoch = record.locator.key_epoch.saturating_add(1);
    record.locator.padding_bucket = match record.locator.padding_bucket {
        StoredPaddingBucketV0Alpha1::Bytes1024 => StoredPaddingBucketV0Alpha1::Bytes4096,
        _ => StoredPaddingBucketV0Alpha1::Bytes1024,
    };

    let checklist = inspect_synthetic_rotation_checklist_v1(&session, &record).unwrap();
    assert!(record.envelope == before);
    assert!(checklist.generation() == SyntheticRotationChecklistGenerationV1::Initial0001);
    assert_eq!(checklist.entries().len(), 1);
    assert!(checklist.entries()[0].fixture() == SyntheticRotationChecklistFixtureV1::Mcp);
}
