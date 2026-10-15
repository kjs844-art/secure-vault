//! Read compatibility and immutable-history checks for synthetic cutover events.
//! Expected payloads are built independently of the production transition.

use super::*;

fn completed_required_record(session: &VaultSession) -> SealedCredentialRecordV0Alpha1 {
    let original =
        seal_synthetic_fixture_v1(session, SyntheticCredentialFixtureId::SingleMcpConnection)
            .unwrap();
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0],
        &[],
        SyntheticVerificationEvidenceV1::ProviderVerified,
    )
    .unwrap();
    record_from_successor(
        &create_synthetic_rotation_cutover_successor_v1(session, &original, &selection).unwrap(),
    )
}

#[test]
fn repeated_cutover_after_general_and_connection_edits_preserves_all_prior_payloads() {
    let password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_rotation_lifecycle".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let session = &created.session;
    let mut initial =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    initial.connections[0].required_for_cutover = true;
    initial.notes = Some("DEMO_VALUE_ONLY_history_notes".to_owned());
    initial.tags = vec!["synthetic-history".to_owned()];
    initial.connections[1].notes = Some("DEMO_VALUE_ONLY_retained_connection".to_owned());
    let original = seal_item_v1(session, initial).unwrap();
    let original_bytes = original.envelope.clone();
    let original_item = decode(session, &original);
    let first_selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0, 2],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let first = record_from_successor(
        &create_synthetic_rotation_cutover_successor_v1(session, &original, &first_selection)
            .unwrap(),
    );
    let first_bytes = first.envelope.clone();
    let first_item = decode(session, &first);

    let general_candidate = crate::create_synthetic_successor_v1(session, &first).unwrap();
    assert!(
        general_candidate
            .persistence_projection_v1()
            .expected_revision_id()
            == Some(first.locator.revision_id)
    );
    let general = record_from_successor(&general_candidate);
    let general_bytes = general.envelope.clone();
    let mut expected_general = decode(session, &first);
    expected_general.parent_revision_id = Some(first.locator.revision_id);
    expected_general.rotation_state = None;
    assert_item_preserved(&expected_general, &decode(session, &general));

    // Retain the existing CLI and MCP in a new order; remove only the CI.
    let connection_selection = crate::SyntheticConnectionSelectionV1::from_ids(&[1, 0]).unwrap();
    let edited_candidate =
        crate::create_synthetic_connection_successor_v1(session, &general, &connection_selection)
            .unwrap();
    assert!(
        edited_candidate
            .persistence_projection_v1()
            .expected_revision_id()
            == Some(general.locator.revision_id)
    );
    let edited = record_from_successor(&edited_candidate);
    let edited_bytes = edited.envelope.clone();
    let mut expected_edited = decode(session, &general);
    expected_edited.parent_revision_id = Some(general.locator.revision_id);
    expected_edited.connections.swap(0, 1);
    expected_edited.connections.truncate(2);
    assert_item_preserved(&expected_edited, &decode(session, &edited));

    // Previous completion evidence must not satisfy the new key's checklist.
    let pending = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[1],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    assert!(matches!(
        inspect_synthetic_rotation_readiness_v1(session, &edited, &pending).unwrap(),
        SyntheticRotationReadinessV1::RequiredPending {
            remaining_required: 1
        }
    ));
    assert!(create_synthetic_rotation_cutover_successor_v1(session, &edited, &pending).is_err());
    let second_selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[0],
        SyntheticVerificationEvidenceV1::ProviderVerified,
    )
    .unwrap();
    assert!(matches!(
        inspect_synthetic_rotation_readiness_v1(session, &edited, &second_selection).unwrap(),
        SyntheticRotationReadinessV1::Ready {
            remaining_optional: 1
        }
    ));
    let second_candidate =
        create_synthetic_rotation_cutover_successor_v1(session, &edited, &second_selection)
            .unwrap();
    assert!(
        second_candidate
            .persistence_projection_v1()
            .expected_revision_id()
            == Some(edited.locator.revision_id)
    );
    let second = record_from_successor(&second_candidate);
    let mut expected_second = decode(session, &edited);
    expected_second.parent_revision_id = Some(edited.locator.revision_id);
    expected_second.secret_fields[0].value =
        SecretValueV1::new(b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0003".to_vec()).unwrap();
    expected_second.updated_at = UtcTimestampV1::new("2026-09-17T00:00:00Z".to_owned()).unwrap();
    expected_second.connections[0].status = ConnectionStatusV1::UpdateRequired;
    expected_second.connections[0].verification_source = VerificationSourceV1::None;
    expected_second.connections[0].last_verified_at = None;
    expected_second.connections[1].status = ConnectionStatusV1::Verified;
    expected_second.connections[1].verification_source = VerificationSourceV1::ProviderConnector;
    expected_second.connections[1].last_verified_at =
        Some(UtcTimestampV1::new("2026-09-17T00:00:00Z".to_owned()).unwrap());
    expected_second.rotation_state = Some(RotationStateV1 {
        supersedes_revision_id: edited.locator.revision_id,
        required_connection_ids: vec![expected_second.connections[1].connection_id],
        completed_connection_ids: vec![expected_second.connections[1].connection_id],
        superseded_external_revocation_status: ExternalRevocationStatusV1::ProviderVerified,
        superseded_external_revocation_attestation:
            ExternalRevocationAttestationV1::ProviderConnector,
        superseded_revoked_at: Some(
            UtcTimestampV1::new("2026-09-17T00:00:00Z".to_owned()).unwrap(),
        ),
    });
    assert_item_preserved(&expected_second, &decode(session, &second));
    assert!(original.envelope == original_bytes);
    assert!(first.envelope == first_bytes);
    assert!(general.envelope == general_bytes);
    assert!(edited.envelope == edited_bytes);

    let password_envelope = created.password_envelope;
    drop(created.session);
    let reopened = unlock_vault_v0alpha1(&password, &password_envelope).unwrap();
    assert_item_preserved(&original_item, &decode(&reopened, &original));
    assert_item_preserved(&first_item, &decode(&reopened, &first));
    assert_item_preserved(&expected_general, &decode(&reopened, &general));
    assert_item_preserved(&expected_edited, &decode(&reopened, &edited));
    assert_item_preserved(&expected_second, &decode(&reopened, &second));
}

#[test]
fn completed_event_can_be_edited_directly_even_when_connections_change() {
    let session = session();
    let completed = completed_required_record(&session);
    let before = completed.envelope.clone();
    let selection = crate::SyntheticConnectionSelectionV1::from_ids(&[]).unwrap();
    let candidate =
        crate::create_synthetic_connection_successor_v1(&session, &completed, &selection).unwrap();
    let edited = record_from_successor(&candidate);
    let mut expected = decode(&session, &completed);
    expected.parent_revision_id = Some(completed.locator.revision_id);
    expected.rotation_state = None;
    expected.connections.clear();
    assert_item_preserved(&expected, &decode(&session, &edited));
    let historical = decode(&session, &completed);
    assert!(historical.rotation_state.is_some());
    assert_eq!(historical.connections.len(), 1);
    assert!(completed.envelope == before);
}

#[test]
fn legacy_readable_events_that_are_not_completed_fail_before_edit_or_rng() {
    let session = session();
    let completed = completed_required_record(&session);
    let selections = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let connections = crate::SyntheticConnectionSelectionV1::from_ids(&[0]).unwrap();
    for case in 0..13 {
        let mut legacy_item = decode(&session, &completed);
        match case {
            0 => legacy_item.status = CredentialStatusV1::Rotating,
            1 => legacy_item.status = CredentialStatusV1::Compromised,
            2 => legacy_item.status = CredentialStatusV1::Disabled,
            3 => legacy_item.status = CredentialStatusV1::Revoked,
            4 => legacy_item
                .rotation_state
                .as_mut()
                .unwrap()
                .completed_connection_ids
                .clear(),
            5 => legacy_item.connections[0].status = ConnectionStatusV1::Connected,
            6 => legacy_item.connections[0].status = ConnectionStatusV1::UpdateRequired,
            7 => legacy_item.connections[0].verification_source = VerificationSourceV1::None,
            8 => legacy_item.connections[0].last_verified_at = None,
            9 => {
                legacy_item
                    .rotation_state
                    .as_mut()
                    .unwrap()
                    .superseded_revoked_at = None
            }
            10 => {
                let event = legacy_item.rotation_state.as_mut().unwrap();
                event.superseded_external_revocation_status = ExternalRevocationStatusV1::Pending;
                event.superseded_external_revocation_attestation =
                    ExternalRevocationAttestationV1::None;
                event.superseded_revoked_at = None;
            }
            11 => {
                let event = legacy_item.rotation_state.as_mut().unwrap();
                event.superseded_external_revocation_attestation =
                    ExternalRevocationAttestationV1::User;
                event.superseded_revoked_at = None;
            }
            12 => {
                let event = legacy_item.rotation_state.as_mut().unwrap();
                event.superseded_external_revocation_status = ExternalRevocationStatusV1::Unknown;
                event.superseded_external_revocation_attestation =
                    ExternalRevocationAttestationV1::None;
                event.superseded_revoked_at = None;
            }
            _ => unreachable!(),
        }
        // These states remain valid under the old V1 decoder. No global codec
        // tightening may turn preserved archives into unreadable corruption.
        let legacy = seal_item_v1(&session, legacy_item).unwrap();
        let before = legacy.envelope.clone();
        assert!(decode(&session, &legacy).rotation_state.is_some());
        assert!(matches!(
            crate::open_credential_record_v1(&session, &legacy).unwrap(),
            crate::OpenCredentialOutcome::Current(_)
        ));
        let mut edits = 0_u8;
        let mut draws = 0_u8;
        let outcome = create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
            &session,
            &legacy,
            |_, _| {
                edits += 1;
                Ok(())
            },
            |revision| {
                draws += 1;
                revision.fill(0x6c);
                Ok(())
            },
        );
        assert_eq!(expect_error_code(outcome), LocalVaultErrorCode::InvalidItem);
        assert_eq!(edits, 0, "case {case}");
        assert_eq!(draws, 0, "case {case}");
        assert!(crate::create_synthetic_successor_v1(&session, &legacy).is_err());
        assert!(
            crate::create_synthetic_connection_successor_v1(&session, &legacy, &connections)
                .is_err()
        );
        assert!(
            create_synthetic_rotation_cutover_successor_v1(&session, &legacy, &selections).is_err()
        );
        assert!(inspect_synthetic_rotation_readiness_v1(&session, &legacy, &selections).is_err());
        assert!(legacy.envelope == before);
    }
}

#[test]
fn terminal_synthetic_generation_refuses_rotation_without_blocking_ordinary_edits() {
    let session = session();
    let first = completed_required_record(&session);
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[0],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let terminal = record_from_successor(
        &create_synthetic_rotation_cutover_successor_v1(&session, &first, &selection).unwrap(),
    );
    let ordinary =
        record_from_successor(&crate::create_synthetic_successor_v1(&session, &terminal).unwrap());
    for record in [&terminal, &ordinary] {
        let before = record.envelope.clone();
        assert!(
            decode(&session, record).secret_fields[0].value.expose()
                == b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0003"
        );
        assert_eq!(
            expect_error_code(inspect_synthetic_rotation_readiness_v1(
                &session, record, &selection,
            )),
            LocalVaultErrorCode::InvalidItem
        );
        let mut draws = 0_u8;
        let outcome = create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
            &session,
            record,
            |item, revision| apply_cutover(item, revision, &selection),
            |revision| {
                draws += 1;
                revision.fill(0x6d);
                Ok(())
            },
        );
        assert_eq!(expect_error_code(outcome), LocalVaultErrorCode::InvalidItem);
        assert_eq!(draws, 0);
        let connections = crate::SyntheticConnectionSelectionV1::from_ids(&[0]).unwrap();
        let edited = record_from_successor(
            &crate::create_synthetic_connection_successor_v1(&session, record, &connections)
                .unwrap(),
        );
        let mut expected = decode(&session, record);
        expected.parent_revision_id = Some(record.locator.revision_id);
        expected.rotation_state = None;
        assert_item_preserved(&expected, &decode(&session, &edited));
        assert!(record.envelope == before);
    }
}

#[test]
fn second_cutover_resets_old_completion_instead_of_reusing_first_generation_evidence() {
    let session = session();
    let first = completed_required_record(&session);
    let before = first.envelope.clone();
    let empty = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    assert!(matches!(
        inspect_synthetic_rotation_readiness_v1(&session, &first, &empty).unwrap(),
        SyntheticRotationReadinessV1::RequiredPending {
            remaining_required: 1
        }
    ));
    let mut draws = 0_u8;
    let outcome = create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
        &session,
        &first,
        |item, revision| apply_cutover(item, revision, &empty),
        |revision| {
            draws += 1;
            revision.fill(0x6e);
            Ok(())
        },
    );
    assert_eq!(expect_error_code(outcome), LocalVaultErrorCode::InvalidItem);
    assert_eq!(draws, 0);
    assert!(first.envelope == before);
    assert!(decode(&session, &first).connections[0].status == ConnectionStatusV1::Verified);
}

#[test]
fn failed_successor_after_completed_event_preserves_history_and_revision_entropy_order() {
    let session = session();
    let first = completed_required_record(&session);
    let before = first.envelope.clone();
    let preserved = decode(&session, &first);
    let mut draws = 0_u8;
    let edit_failure = create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
        &session,
        &first,
        |item, predecessor_revision| {
            assert!(item.rotation_state.is_none());
            assert!(predecessor_revision == first.locator.revision_id);
            Err(LocalVaultError::InvalidItem)
        },
        |revision| {
            draws += 1;
            revision.fill(0x6f);
            Ok(())
        },
    );
    assert_eq!(
        expect_error_code(edit_failure),
        LocalVaultErrorCode::InvalidItem
    );
    assert_eq!(draws, 0);

    let rng_failure = create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
        &session,
        &first,
        |item, _| {
            assert!(item.rotation_state.is_none());
            Ok(())
        },
        |revision| {
            draws += 1;
            assert_eq!(revision.len(), 32);
            Err(LocalVaultError::RngUnavailable)
        },
    );
    assert_eq!(
        expect_error_code(rng_failure),
        LocalVaultErrorCode::RngUnavailable
    );
    assert_eq!(draws, 1);
    assert!(first.envelope == before);
    assert_item_preserved(&preserved, &decode(&session, &first));
}

#[test]
fn second_cutover_and_connection_edit_candidates_share_expected_head_without_history_loss() {
    let session = session();
    let first = completed_required_record(&session);
    let before = first.envelope.clone();
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let mut draws = 0_u8;
    let second = create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
        &session,
        &first,
        |item, predecessor_revision| apply_cutover(item, predecessor_revision, &selection),
        |revision| {
            draws += 1;
            assert_eq!(revision.len(), 32);
            revision.fill(0x70);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(draws, 1);
    let connections = crate::SyntheticConnectionSelectionV1::from_ids(&[]).unwrap();
    let edited =
        crate::create_synthetic_connection_successor_v1(&session, &first, &connections).unwrap();
    let cutover = second.persistence_projection_v1();
    let edit = edited.persistence_projection_v1();
    assert!(cutover.expected_revision_id() == Some(first.locator.revision_id));
    assert!(edit.expected_revision_id() == Some(first.locator.revision_id));
    assert_eq!(cutover.revision_id().as_bytes(), &[0x70; 32]);
    assert!(cutover.revision_id() != edit.revision_id());
    assert!(cutover.record_id() == edit.record_id());
    assert!(first.envelope == before);
    assert!(decode(&session, &first).rotation_state.is_some());
    assert!(
        decode(&session, &record_from_successor(&edited))
            .rotation_state
            .is_none()
    );
    let event = decode(&session, &record_from_successor(&second))
        .rotation_state
        .unwrap();
    assert!(event.supersedes_revision_id == first.locator.revision_id);
}

#[test]
fn malformed_optional_connection_state_cannot_be_hidden_by_clearing_the_event() {
    let session = session();
    let mut initial =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::MultipleConsumers).unwrap();
    initial.connections[0].required_for_cutover = true;
    let original = seal_item_v1(&session, initial).unwrap();
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let completed = record_from_successor(
        &create_synthetic_rotation_cutover_successor_v1(&session, &original, &selection).unwrap(),
    );
    let completed_item = decode(&session, &completed);
    assert!(completed_item.connections[0].status == ConnectionStatusV1::Verified);
    assert!(completed_item.connections[1].status == ConnectionStatusV1::UpdateRequired);

    for case in 0..4 {
        let mut malformed = decode(&session, &completed);
        match case {
            0 => malformed.connections[1].status = ConnectionStatusV1::Connected,
            1 => {
                malformed.connections[1].status = ConnectionStatusV1::Verified;
                malformed.connections[1].verification_source = VerificationSourceV1::User;
                malformed.connections[1].last_verified_at =
                    Some(UtcTimestampV1::new("2026-09-15T00:00:00Z".to_owned()).unwrap());
            }
            2 => {
                malformed.connections[1].verification_source = VerificationSourceV1::User;
            }
            3 => {
                malformed.connections[1].last_verified_at =
                    Some(UtcTimestampV1::new("2026-09-16T00:00:00Z".to_owned()).unwrap());
            }
            _ => unreachable!(),
        }
        let legacy = seal_item_v1(&session, malformed).unwrap();
        let before = legacy.envelope.clone();
        let mut edits = 0_u8;
        let mut draws = 0_u8;
        let outcome = create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
            &session,
            &legacy,
            |_, _| {
                edits += 1;
                Ok(())
            },
            |revision| {
                draws += 1;
                revision.fill(0x71);
                Ok(())
            },
        );
        assert_eq!(expect_error_code(outcome), LocalVaultErrorCode::InvalidItem);
        assert_eq!(edits, 0, "case {case}");
        assert_eq!(draws, 0, "case {case}");
        assert!(crate::create_synthetic_successor_v1(&session, &legacy).is_err());
        let connections = crate::SyntheticConnectionSelectionV1::from_ids(&[0, 1, 2]).unwrap();
        assert!(
            crate::create_synthetic_connection_successor_v1(&session, &legacy, &connections)
                .is_err()
        );
        assert!(inspect_synthetic_rotation_readiness_v1(&session, &legacy, &selection).is_err());
        assert!(
            create_synthetic_rotation_cutover_successor_v1(&session, &legacy, &selection).is_err()
        );
        assert!(legacy.envelope == before);
    }
}
