//! Synthetic-only rotation checks. Assertions never print credential values.

use vault_crypto::{MasterPassword, VaultSession, create_vault_v0alpha1, unlock_vault_v0alpha1};

use super::*;
use crate::codec::preservation_tests::assert_item_preserved;
use crate::codec::{DecodedItem, decode_item};
use crate::model::{
    ConnectionStatusV1, ExternalRevocationAttestationV1, ExternalRevocationStatusV1,
    VerificationSourceV1,
};
use crate::record::{record_context, seal_item_v1, sealed_from_current_envelope};
use crate::registration::SyntheticRegistrationSelectionV1;
use crate::synthetic::build_synthetic_fixture_v1;
use crate::{
    LocalVaultErrorCode, SyntheticCredentialFixtureId, seal_synthetic_fixture_v1,
    seal_synthetic_registration_v1,
};

fn session() -> VaultSession {
    let password = MasterPassword::from_utf8("DEMO_VALUE_ONLY_rotation_tests".to_owned()).unwrap();
    create_vault_v0alpha1(&password).unwrap().session
}

fn decode(session: &VaultSession, record: &SealedCredentialRecordV0Alpha1) -> CredentialItemV1 {
    let context = record_context(
        session,
        record.locator.record_id,
        record.locator.revision_id,
        record.locator.key_epoch,
        record.locator.padding_bucket,
    )
    .unwrap();
    let plaintext =
        vault_crypto::open_record_v0alpha1(session, &context, &record.envelope).unwrap();
    match decode_item(&plaintext, record.locator.revision_id).unwrap() {
        DecodedItem::Current(item) => item,
        DecodedItem::UpgradeRequired { .. } => panic!("current synthetic item required"),
    }
}

fn record_from_successor(
    successor: &SyntheticCredentialSuccessorV1,
) -> SealedCredentialRecordV0Alpha1 {
    sealed_from_current_envelope(successor.persistence_projection_v1().envelope().to_vec()).unwrap()
}

fn expect_error_code<T>(result: Result<T, LocalVaultError>) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("an invalid synthetic rotation was accepted"),
        Err(error) => error.code(),
    }
}

#[test]
fn required_cutover_replaces_only_the_closed_secret_and_binds_the_revision_chain() {
    let session = session();
    let predecessor =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::SingleMcpConnection)
            .unwrap();
    let predecessor_bytes = predecessor.envelope.clone();
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0],
        &[],
        SyntheticVerificationEvidenceV1::ProviderVerified,
    )
    .unwrap();

    let readiness =
        inspect_synthetic_rotation_readiness_v1(&session, &predecessor, &selection).unwrap();
    assert!(matches!(
        readiness,
        SyntheticRotationReadinessV1::Ready {
            remaining_optional: 0
        }
    ));

    let successor =
        create_synthetic_rotation_cutover_successor_v1(&session, &predecessor, &selection).unwrap();
    let projection = successor.persistence_projection_v1();
    assert!(projection.record_id() == predecessor.locator.record_id);
    assert!(projection.revision_id() != predecessor.locator.revision_id);
    assert!(projection.expected_revision_id() == Some(predecessor.locator.revision_id));

    let sealed = record_from_successor(&successor);
    let item = decode(&session, &sealed);
    assert!(item.parent_revision_id == Some(predecessor.locator.revision_id));
    assert!(item.status == CredentialStatusV1::Active);
    assert!(item.external_revocation_status == ExternalRevocationStatusV1::NotRequested);
    assert!(item.external_revocation_attestation == ExternalRevocationAttestationV1::None);
    assert!(item.revoked_at.is_none());
    assert_eq!(item.secret_fields.len(), 1);
    assert!(item.secret_fields[0].value.expose() == ROTATED_SYNTHETIC_API_KEY);
    assert_eq!(item.connections.len(), 1);
    assert!(item.connections[0].status == ConnectionStatusV1::Verified);
    assert!(item.connections[0].verification_source == VerificationSourceV1::User);
    assert!(item.connections[0].last_verified_at.is_some());

    let rotation = item.rotation_state.as_ref().unwrap();
    assert!(rotation.supersedes_revision_id == predecessor.locator.revision_id);
    assert!(rotation.required_connection_ids == vec![item.connections[0].connection_id]);
    assert!(rotation.completed_connection_ids == rotation.required_connection_ids);
    assert!(
        rotation.superseded_external_revocation_status
            == ExternalRevocationStatusV1::ProviderVerified
    );
    assert!(
        rotation.superseded_external_revocation_attestation
            == ExternalRevocationAttestationV1::ProviderConnector
    );
    assert!(rotation.superseded_revoked_at.is_some());
    assert!(predecessor.envelope == predecessor_bytes);
}

#[test]
fn optional_connections_remain_visible_as_update_required_without_blocking_cutover() {
    let session = session();
    let predecessor =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::MultipleConsumers)
            .unwrap();
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[1],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();

    let readiness =
        inspect_synthetic_rotation_readiness_v1(&session, &predecessor, &selection).unwrap();
    assert!(matches!(
        readiness,
        SyntheticRotationReadinessV1::Ready {
            remaining_optional: 2
        }
    ));

    let successor =
        create_synthetic_rotation_cutover_successor_v1(&session, &predecessor, &selection).unwrap();
    let sealed = record_from_successor(&successor);
    let item = decode(&session, &sealed);
    assert_eq!(item.connections.len(), 3);
    assert!(item.connections[0].status == ConnectionStatusV1::UpdateRequired);
    assert!(item.connections[0].verification_source == VerificationSourceV1::None);
    assert!(item.connections[0].last_verified_at.is_none());
    assert!(item.connections[1].status == ConnectionStatusV1::Verified);
    assert!(item.connections[1].verification_source == VerificationSourceV1::ProviderConnector);
    assert!(item.connections[1].last_verified_at.is_some());
    assert!(item.connections[2].status == ConnectionStatusV1::UpdateRequired);
    assert!(item.connections[2].verification_source == VerificationSourceV1::None);
    assert!(item.connections[2].last_verified_at.is_none());
    let rotation = item.rotation_state.as_ref().unwrap();
    assert!(rotation.required_connection_ids.is_empty());
    assert!(rotation.completed_connection_ids.is_empty());
}

#[test]
fn missing_required_connection_returns_pending_and_draws_no_revision_entropy() {
    let session = session();
    let predecessor =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::SingleMcpConnection)
            .unwrap();
    let predecessor_bytes = predecessor.envelope.clone();
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let readiness =
        inspect_synthetic_rotation_readiness_v1(&session, &predecessor, &selection).unwrap();
    assert!(matches!(
        readiness,
        SyntheticRotationReadinessV1::RequiredPending {
            remaining_required: 1
        }
    ));

    let mut calls = 0_u8;
    let result = create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
        &session,
        &predecessor,
        |item, revision| apply_cutover(item, revision, &selection),
        |revision| {
            calls = calls.saturating_add(1);
            revision.fill(0x5a);
            Ok(())
        },
    );
    assert_eq!(expect_error_code(result), LocalVaultErrorCode::InvalidItem);
    assert_eq!(calls, 0);
    assert!(predecessor.envelope == predecessor_bytes);
}

#[test]
fn selections_reject_duplicates_overlap_unknown_absent_and_removed_fixtures() {
    for (user, provider) in [
        (&[0, 0][..], &[][..]),
        (&[][..], &[1, 1][..]),
        (&[2][..], &[2][..]),
        (&[3][..], &[][..]),
    ] {
        assert_eq!(
            expect_error_code(SyntheticRotationCutoverSelectionV1::from_fixture_ids(
                user,
                provider,
                SyntheticVerificationEvidenceV1::UserConfirmed,
            )),
            LocalVaultErrorCode::InvalidItem
        );
    }
    assert_eq!(
        expect_error_code(SyntheticRotationCutoverSelectionV1::from_fixture_ids(
            &[0, 1, 2],
            &[0],
            SyntheticVerificationEvidenceV1::UserConfirmed,
        )),
        LocalVaultErrorCode::LimitsExceeded
    );

    let session = session();
    let empty =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    let mcp = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    assert_eq!(
        expect_error_code(inspect_synthetic_rotation_readiness_v1(
            &session, &empty, &mcp
        )),
        LocalVaultErrorCode::InvalidItem
    );

    let mut item =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::SingleMcpConnection).unwrap();
    item.connections[0].status = ConnectionStatusV1::Removed;
    let removed = seal_item_v1(&session, item).unwrap();
    assert_eq!(
        expect_error_code(inspect_synthetic_rotation_readiness_v1(
            &session, &removed, &mcp
        )),
        LocalVaultErrorCode::InvalidItem
    );
}

#[test]
fn wrong_session_tamper_future_and_completed_rotation_fail_before_revision_entropy() {
    let session = session();
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let original =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();

    let other_password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_rotation_other".to_owned()).unwrap();
    let other = create_vault_v0alpha1(&other_password).unwrap();
    let mut tampered =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    *tampered.envelope.last_mut().unwrap() ^= 1;
    let future = crate::record::seal_synthetic_future_inner_v2(&session).unwrap();
    let completed = record_from_successor(
        &create_synthetic_rotation_cutover_successor_v1(&session, &original, &selection).unwrap(),
    );

    let cases = [
        (&other.session, &original),
        (&session, &tampered),
        (&session, &future),
        (&session, &completed),
    ];
    for (candidate_session, record) in cases {
        let before = record.envelope.clone();
        let mut calls = 0_u8;
        let result = create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
            candidate_session,
            record,
            |item, revision| apply_cutover(item, revision, &selection),
            |revision| {
                calls = calls.saturating_add(1);
                revision.fill(0x6b);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(calls, 0);
        assert!(record.envelope == before);
    }
}

#[test]
fn final_cutover_uses_one_revision_draw_and_rng_failure_returns_no_candidate() {
    let session = session();
    let predecessor =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    let predecessor_bytes = predecessor.envelope.clone();
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[],
        SyntheticVerificationEvidenceV1::ProviderVerified,
    )
    .unwrap();
    let mut calls = 0_u8;
    let successor = create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
        &session,
        &predecessor,
        |item, revision| apply_cutover(item, revision, &selection),
        |revision| {
            calls = calls.saturating_add(1);
            assert_eq!(revision.len(), 32);
            revision.fill(0x5a);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(calls, 1);
    assert_eq!(
        successor
            .persistence_projection_v1()
            .revision_id()
            .as_bytes(),
        &[0x5a; 32]
    );

    let mut failed_calls = 0_u8;
    let failure = create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
        &session,
        &predecessor,
        |item, revision| apply_cutover(item, revision, &selection),
        |_| {
            failed_calls = failed_calls.saturating_add(1);
            Err(LocalVaultError::RngUnavailable)
        },
    );
    assert_eq!(
        expect_error_code(failure),
        LocalVaultErrorCode::RngUnavailable
    );
    assert_eq!(failed_calls, 1);
    assert!(predecessor.envelope == predecessor_bytes);
}

#[test]
fn registration_profiles_preserve_unrelated_fields_and_roundtrip_after_reunlock() {
    let password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_rotation_reunlock".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let registration = SyntheticRegistrationSelectionV1::from_ids(1, 0, &[0, 1, 2]).unwrap();
    let predecessor = seal_synthetic_registration_v1(&created.session, &registration).unwrap();
    let predecessor_revision = predecessor.locator.revision_id;
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0, 2],
        &[1],
        SyntheticVerificationEvidenceV1::ProviderVerified,
    )
    .unwrap();
    let mut expected = decode(&created.session, &predecessor);
    // Deliberately independent of apply_cutover: only these fields may change.
    expected.secret_fields[0].value =
        SecretValueV1::new(b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0002".to_vec()).unwrap();
    expected.updated_at = UtcTimestampV1::new("2026-09-16T00:00:00Z".to_owned()).unwrap();
    for (index, connection) in expected.connections.iter_mut().enumerate() {
        connection.status = ConnectionStatusV1::Verified;
        connection.verification_source = if index == 1 {
            VerificationSourceV1::ProviderConnector
        } else {
            VerificationSourceV1::User
        };
        connection.last_verified_at =
            Some(UtcTimestampV1::new("2026-09-16T00:00:00Z".to_owned()).unwrap());
    }
    let required: Vec<_> = expected
        .connections
        .iter()
        .map(|c| c.connection_id)
        .collect();
    expected.rotation_state = Some(RotationStateV1 {
        supersedes_revision_id: predecessor_revision,
        required_connection_ids: required.clone(),
        completed_connection_ids: required,
        superseded_external_revocation_status: ExternalRevocationStatusV1::ProviderVerified,
        superseded_external_revocation_attestation:
            ExternalRevocationAttestationV1::ProviderConnector,
        superseded_revoked_at: Some(
            UtcTimestampV1::new("2026-09-16T00:00:00Z".to_owned()).unwrap(),
        ),
    });

    let successor =
        create_synthetic_rotation_cutover_successor_v1(&created.session, &predecessor, &selection)
            .unwrap();
    let sealed = record_from_successor(&successor);
    expected.parent_revision_id = Some(predecessor_revision);
    let actual = decode(&created.session, &sealed);
    assert_item_preserved(&expected, &actual);

    let password_envelope = created.password_envelope;
    drop(created.session);
    let reopened = unlock_vault_v0alpha1(&password, &password_envelope).unwrap();
    let restored = decode(&reopened, &sealed);
    assert_item_preserved(&expected, &restored);
}

#[test]
fn sibling_cutover_candidates_share_the_expected_head_but_not_revision_ids() {
    let session = session();
    let predecessor =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let first =
        create_synthetic_rotation_cutover_successor_v1(&session, &predecessor, &selection).unwrap();
    let second =
        create_synthetic_rotation_cutover_successor_v1(&session, &predecessor, &selection).unwrap();
    let first = first.persistence_projection_v1();
    let second = second.persistence_projection_v1();
    assert!(first.expected_revision_id() == Some(predecessor.locator.revision_id));
    assert!(second.expected_revision_id() == Some(predecessor.locator.revision_id));
    assert!(first.revision_id() != second.revision_id());
}

#[test]
fn mixed_required_optional_and_removed_connections_preserve_unrelated_populated_fields() {
    let session = session();
    let mut initial =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    initial.connections[0].required_for_cutover = true;
    initial.connections[2].required_for_cutover = true;
    initial.connections[2].status = ConnectionStatusV1::Removed;
    initial.notes = Some("DEMO_VALUE_ONLY_rotation_preserves_notes".to_owned());
    initial.tags = vec!["synthetic-rotation".to_owned()];
    initial.connections[1].notes = Some("DEMO_VALUE_ONLY_optional_notes".to_owned());
    initial.status = CredentialStatusV1::Compromised;
    initial.external_revocation_status = ExternalRevocationStatusV1::UserConfirmed;
    initial.external_revocation_attestation = ExternalRevocationAttestationV1::User;
    initial.revoked_at = Some(UtcTimestampV1::new("2026-09-15T00:00:00Z".to_owned()).unwrap());
    let predecessor = seal_item_v1(&session, initial).unwrap();
    let before = predecessor.envelope.clone();
    let pending = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[1],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    assert!(matches!(
        inspect_synthetic_rotation_readiness_v1(&session, &predecessor, &pending).unwrap(),
        SyntheticRotationReadinessV1::RequiredPending {
            remaining_required: 1
        }
    ));
    assert!(
        create_synthetic_rotation_cutover_successor_v1(&session, &predecessor, &pending).is_err()
    );

    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[0],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    assert!(matches!(
        inspect_synthetic_rotation_readiness_v1(&session, &predecessor, &selection).unwrap(),
        SyntheticRotationReadinessV1::Ready {
            remaining_optional: 1
        }
    ));
    let successor =
        create_synthetic_rotation_cutover_successor_v1(&session, &predecessor, &selection).unwrap();
    let sealed = record_from_successor(&successor);
    let actual = decode(&session, &sealed);
    let mut expected = decode(&session, &predecessor);
    expected.parent_revision_id = Some(predecessor.locator.revision_id);
    expected.secret_fields[0].value =
        SecretValueV1::new(b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0002".to_vec()).unwrap();
    expected.status = CredentialStatusV1::Active;
    expected.external_revocation_status = ExternalRevocationStatusV1::NotRequested;
    expected.external_revocation_attestation = ExternalRevocationAttestationV1::None;
    expected.revoked_at = None;
    expected.updated_at = UtcTimestampV1::new("2026-09-16T00:00:00Z".to_owned()).unwrap();
    expected.connections[0].status = ConnectionStatusV1::Verified;
    expected.connections[0].verification_source = VerificationSourceV1::ProviderConnector;
    expected.connections[0].last_verified_at =
        Some(UtcTimestampV1::new("2026-09-16T00:00:00Z".to_owned()).unwrap());
    expected.connections[1].status = ConnectionStatusV1::UpdateRequired;
    expected.connections[1].verification_source = VerificationSourceV1::None;
    expected.connections[1].last_verified_at = None;
    expected.rotation_state = Some(RotationStateV1 {
        supersedes_revision_id: predecessor.locator.revision_id,
        required_connection_ids: vec![expected.connections[0].connection_id],
        completed_connection_ids: vec![expected.connections[0].connection_id],
        superseded_external_revocation_status: ExternalRevocationStatusV1::UserConfirmed,
        superseded_external_revocation_attestation: ExternalRevocationAttestationV1::User,
        superseded_revoked_at: Some(
            UtcTimestampV1::new("2026-09-16T00:00:00Z".to_owned()).unwrap(),
        ),
    });
    // Checks every unrelated field, including the secondary Secret and removed
    // connection, without invoking the production edit to build the oracle.
    assert_item_preserved(&expected, &actual);
    assert!(predecessor.envelope == before);
}

#[test]
fn completed_cutover_refuses_further_edits_until_history_semantics_are_supported() {
    let session = session();
    let predecessor =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let successor =
        create_synthetic_rotation_cutover_successor_v1(&session, &predecessor, &selection).unwrap();
    let completed = record_from_successor(&successor);
    let before = completed.envelope.clone();
    let connections = crate::SyntheticConnectionSelectionV1::from_ids(&[0]).unwrap();
    assert!(
        crate::create_synthetic_connection_successor_v1(&session, &completed, &connections)
            .is_err()
    );
    assert!(crate::create_synthetic_successor_v1(&session, &completed).is_err());
    assert!(
        create_synthetic_rotation_cutover_successor_v1(&session, &completed, &selection).is_err()
    );
    assert!(completed.envelope == before);
}

#[test]
fn cutover_uses_authenticated_envelope_revision_instead_of_mutated_locator() {
    let session = session();
    let mut predecessor =
        seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::UnconnectedApiKey)
            .unwrap();
    let authoritative_revision = predecessor.persistence_projection_v1().revision_id();
    predecessor.locator.revision_id = crate::ids::RevisionIdV1::from_bytes([0x19; 32]);
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let successor =
        create_synthetic_rotation_cutover_successor_v1(&session, &predecessor, &selection).unwrap();
    assert!(
        successor.persistence_projection_v1().expected_revision_id()
            == Some(authoritative_revision)
    );
    let actual = decode(&session, &record_from_successor(&successor));
    assert!(actual.parent_revision_id == Some(authoritative_revision));
    assert!(actual.rotation_state.unwrap().supersedes_revision_id == authoritative_revision);
}
