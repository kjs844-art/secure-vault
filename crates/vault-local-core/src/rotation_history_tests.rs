//! Owned synthetic fixtures only; the history query performs no writes or RNG.

use vault_crypto::{MasterPassword, VaultSession, create_vault_v0alpha1, seal_record_v0alpha1};

use super::*;
use crate::codec::encode_current_item;
use crate::ids::RecordIdV1;
use crate::model::{
    ConnectionStatusV1, CredentialItemV1, CredentialStatusV1, ExternalRevocationAttestationV1,
    ExternalRevocationStatusV1, RotationStateV1, UtcTimestampV1, VerificationSourceV1,
};
use crate::record::{
    StoredPaddingBucketV0Alpha1, record_context, seal_synthetic_future_inner_v2,
    sealed_from_current_envelope, select_bucket,
};
use crate::synthetic::{SyntheticCredentialFixtureId, build_synthetic_fixture_v1};
use crate::{
    LocalVaultErrorCode, OwnedRehydratedCredentialOutcomeV1, OwnedRehydratedCredentialV1,
    SyntheticConnectionSelectionV1, SyntheticCredentialSuccessorV1,
    SyntheticRegistrationSelectionV1, SyntheticRotationCutoverSelectionV1,
    SyntheticVerificationEvidenceV1, create_synthetic_connection_successor_v1,
    create_synthetic_rotation_cutover_successor_v1, create_synthetic_successor_v1,
    inspect_synthetic_rotation_readiness_v1, seal_synthetic_registration_v1,
};

fn session() -> VaultSession {
    let password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_rotation_history".to_owned()).unwrap();
    create_vault_v0alpha1(&password).unwrap().session
}

fn revision(index: u16) -> RevisionIdV1 {
    let mut bytes = [0x75; 32];
    bytes[..2].copy_from_slice(&index.to_le_bytes());
    RevisionIdV1::from_bytes(bytes)
}

fn record_id() -> RecordIdV1 {
    RecordIdV1::from_bytes([0x46; 16])
}

fn plain_item(parent: Option<RevisionIdV1>) -> CredentialItemV1 {
    let mut item =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::SingleMcpConnection).unwrap();
    item.parent_revision_id = parent;
    item
}

fn timestamp(value: &str) -> UtcTimestampV1 {
    UtcTimestampV1::new(value.to_owned()).unwrap()
}

fn event_item(
    parent: RevisionIdV1,
    recorded_completion: Option<(&[u8], &str)>,
    provider: bool,
) -> CredentialItemV1 {
    let mut item = plain_item(Some(parent));
    let connection_id = item.connections[0].connection_id;
    let complete = recorded_completion.is_some();
    if let Some((recorded_secret, recorded_timestamp)) = recorded_completion {
        item.secret_fields[0].value =
            crate::secret::SecretValueV1::new(recorded_secret.to_vec()).unwrap();
        item.connections[0].status = ConnectionStatusV1::Verified;
        item.connections[0].verification_source = VerificationSourceV1::User;
        item.connections[0].last_verified_at = Some(timestamp(recorded_timestamp));
        item.updated_at = timestamp(recorded_timestamp);
    } else {
        item.status = CredentialStatusV1::Rotating;
    }
    let (status, attestation) = if !complete {
        (
            ExternalRevocationStatusV1::Pending,
            ExternalRevocationAttestationV1::None,
        )
    } else if provider {
        (
            ExternalRevocationStatusV1::ProviderVerified,
            ExternalRevocationAttestationV1::ProviderConnector,
        )
    } else {
        (
            ExternalRevocationStatusV1::UserConfirmed,
            ExternalRevocationAttestationV1::User,
        )
    };
    item.rotation_state = Some(RotationStateV1 {
        supersedes_revision_id: parent,
        required_connection_ids: vec![connection_id],
        completed_connection_ids: if complete {
            vec![connection_id]
        } else {
            Vec::new()
        },
        superseded_external_revocation_status: status,
        superseded_external_revocation_attestation: attestation,
        superseded_revoked_at: recorded_completion
            .map(|(_, recorded_timestamp)| timestamp(recorded_timestamp)),
    });
    item
}

fn seal_at(
    session: &VaultSession,
    item: CredentialItemV1,
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
) -> SealedCredentialRecordV0Alpha1 {
    let plaintext = encode_current_item(&item, revision_id).unwrap();
    let bucket = select_bucket(plaintext.expose_secret().len()).unwrap();
    let context = record_context(
        session,
        record_id,
        revision_id,
        session.key_epoch().get(),
        bucket,
    )
    .unwrap();
    let envelope = seal_record_v0alpha1(session, &context, &plaintext).unwrap();
    sealed_from_current_envelope(envelope).unwrap()
}

fn error_code<T>(result: Result<T, LocalVaultError>) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("invalid synthetic history must be rejected"),
        Err(error) => error.code(),
    }
}

fn rehydrate_public_successor(
    session: &VaultSession,
    successor: &SyntheticCredentialSuccessorV1,
) -> OwnedRehydratedCredentialV1 {
    let restored = CredentialStorageAuthenticatorV1::new(session)
        .rehydrate_owned_stored_credential_v1(
            successor.persistence_projection_v1().envelope().to_vec(),
        )
        .unwrap();
    match restored {
        OwnedRehydratedCredentialOutcomeV1::Current(record) => record,
        OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(_) => {
            panic!("public synthetic successor unexpectedly required an upgrade")
        }
    }
}

#[test]
fn public_rotation_and_edit_chain_exposes_only_its_two_recorded_cutover_events() {
    let session = session();
    let registration = SyntheticRegistrationSelectionV1::from_ids(0, 0, &[0, 1, 2]).unwrap();
    let root = seal_synthetic_registration_v1(&session, &registration).unwrap();
    let first_selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0, 2],
        &[1],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let first_candidate =
        create_synthetic_rotation_cutover_successor_v1(&session, &root, &first_selection).unwrap();
    let first = rehydrate_public_successor(&session, &first_candidate);
    let general_candidate = create_synthetic_successor_v1(&session, first.sealed_record()).unwrap();
    let general = rehydrate_public_successor(&session, &general_candidate);
    let connections = SyntheticConnectionSelectionV1::from_ids(&[1, 0]).unwrap();
    let edit_candidate =
        create_synthetic_connection_successor_v1(&session, general.sealed_record(), &connections)
            .unwrap();
    let edit = rehydrate_public_successor(&session, &edit_candidate);
    let second_selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[],
        &[0, 1],
        SyntheticVerificationEvidenceV1::ProviderVerified,
    )
    .unwrap();
    let second_candidate = create_synthetic_rotation_cutover_successor_v1(
        &session,
        edit.sealed_record(),
        &second_selection,
    )
    .unwrap();
    let second = rehydrate_public_successor(&session, &second_candidate);
    let head_candidate = create_synthetic_successor_v1(&session, second.sealed_record()).unwrap();
    let head = rehydrate_public_successor(&session, &head_candidate);
    let chain = [
        &root,
        first.sealed_record(),
        general.sealed_record(),
        edit.sealed_record(),
        second.sealed_record(),
        head.sealed_record(),
    ];
    let before: Vec<_> = chain
        .iter()
        .map(|record| record.persistence_projection_v1().envelope().to_vec())
        .collect();
    // Only the public APIs above create payloads and event evidence. In
    // particular, no hand-built RotationStateV1 supplies the expected events.
    let history = inspect_synthetic_rotation_history_v1(
        &session,
        head.sealed_record(),
        &[
            edit.sealed_record(),
            &root,
            second.sealed_record(),
            first.sealed_record(),
            general.sealed_record(),
        ],
    )
    .unwrap();
    let events = history.events();
    assert_eq!(events.len(), 2);
    assert!(events[0].revision_id() == second_candidate.persistence_projection_v1().revision_id());
    assert!(
        events[0].parent_revision_id() == edit_candidate.persistence_projection_v1().revision_id()
    );
    assert_eq!(events[0].required_connection_count(), 2);
    assert_eq!(events[0].completed_connection_count(), 2);
    assert!(
        events[0].superseded_revocation_source()
            == SyntheticRotationRevocationSourceV1::ProviderConnector
    );
    assert!(events[1].revision_id() == first_candidate.persistence_projection_v1().revision_id());
    assert!(events[1].parent_revision_id() == root.persistence_projection_v1().revision_id());
    assert_eq!(events[1].required_connection_count(), 3);
    assert_eq!(events[1].completed_connection_count(), 3);
    assert!(events[1].superseded_revocation_source() == SyntheticRotationRevocationSourceV1::User);
    assert!(events.iter().all(
        |event| event.recorded_completion() == SyntheticRotationRecordedCompletionV1::Complete
    ));
    for (record, expected_bytes) in chain.iter().zip(before) {
        assert!(record.persistence_projection_v1().envelope() == expected_bytes);
    }
}

#[test]
fn an_older_complete_authenticated_chain_is_accepted_without_claiming_latest_head_authority() {
    let session = session();
    let registration = SyntheticRegistrationSelectionV1::from_ids(1, 0, &[0]).unwrap();
    let root = seal_synthetic_registration_v1(&session, &registration).unwrap();
    let selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let first_candidate =
        create_synthetic_rotation_cutover_successor_v1(&session, &root, &selection).unwrap();
    let first = rehydrate_public_successor(&session, &first_candidate);
    let later_candidate =
        create_synthetic_rotation_cutover_successor_v1(&session, first.sealed_record(), &selection)
            .unwrap();
    let later = rehydrate_public_successor(&session, &later_candidate);
    let records = [&root, first.sealed_record(), later.sealed_record()];
    let before: Vec<_> = records
        .iter()
        .map(|record| record.persistence_projection_v1().envelope().to_vec())
        .collect();
    // Both queries are valid even though the caller knows a newer head. The
    // query authenticates the selected chain; it has no external latest anchor.
    let current = inspect_synthetic_rotation_history_v1(
        &session,
        later.sealed_record(),
        &[&root, first.sealed_record()],
    )
    .unwrap();
    assert_eq!(current.events().len(), 2);
    let older =
        inspect_synthetic_rotation_history_v1(&session, first.sealed_record(), &[&root]).unwrap();
    assert_eq!(older.events().len(), 1);
    assert!(
        older.events()[0].revision_id()
            == first_candidate.persistence_projection_v1().revision_id()
    );
    assert!(
        older.events()[0].recorded_completion() == SyntheticRotationRecordedCompletionV1::Complete
    );
    assert!(
        inspect_synthetic_rotation_history_v1(&session, &root, &[])
            .unwrap()
            .events()
            .is_empty()
    );
    for (record, expected_bytes) in records.iter().zip(before) {
        assert!(record.persistence_projection_v1().envelope() == expected_bytes);
    }
}

#[test]
fn returns_only_events_in_reverse_parent_chain_order_from_shuffled_ancestors() {
    let session = session();
    let root = seal_at(&session, plain_item(None), record_id(), revision(0));
    let first = seal_at(
        &session,
        event_item(
            revision(0),
            Some((
                b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0002",
                "2026-09-16T00:00:00Z",
            )),
            false,
        ),
        record_id(),
        revision(1),
    );
    let mut edit_item = plain_item(Some(revision(1)));
    edit_item.secret_fields[0].value =
        crate::secret::SecretValueV1::new(b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0002".to_vec())
            .unwrap();
    edit_item.updated_at = timestamp("2026-09-16T00:00:00Z");
    let edit = seal_at(&session, edit_item, record_id(), revision(2));
    let head = seal_at(
        &session,
        event_item(
            revision(2),
            Some((
                b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0003",
                "2026-09-17T00:00:00Z",
            )),
            true,
        ),
        record_id(),
        revision(3),
    );
    let records = [&root, &first, &edit, &head];
    let before: Vec<_> = records
        .iter()
        .map(|record| record.envelope.clone())
        .collect();

    let history =
        inspect_synthetic_rotation_history_v1(&session, &head, &[&first, &root, &edit]).unwrap();
    let events = history.events();
    assert_eq!(events.len(), 2);
    assert!(events[0].revision_id() == revision(3));
    assert!(events[0].parent_revision_id() == revision(2));
    assert!(events[1].revision_id() == revision(1));
    assert!(events[1].parent_revision_id() == revision(0));
    assert_eq!(events[0].required_connection_count(), 1);
    assert_eq!(events[0].completed_connection_count(), 1);
    assert!(events.iter().all(
        |event| event.recorded_completion() == SyntheticRotationRecordedCompletionV1::Complete
    ));
    assert!(
        events[0].superseded_revocation_source()
            == SyntheticRotationRevocationSourceV1::ProviderConnector
    );
    assert!(events[1].superseded_revocation_source() == SyntheticRotationRevocationSourceV1::User);
    assert!(
        records
            .iter()
            .zip(before)
            .all(|(record, bytes)| record.envelope == bytes)
    );
}

#[test]
fn a_single_authenticated_root_without_events_returns_an_empty_history() {
    let session = session();
    let root = seal_at(&session, plain_item(None), record_id(), revision(0));
    assert!(
        inspect_synthetic_rotation_history_v1(&session, &root, &[])
            .unwrap()
            .events()
            .is_empty()
    );
}

#[test]
fn decoder_valid_legacy_events_remain_readable_but_incomplete() {
    let session = session();
    let root = seal_at(&session, plain_item(None), record_id(), revision(0));
    let legacy = event_item(revision(0), None, false);
    assert!(validate_completed_rotation_event_v1(&legacy).is_err());
    let head = seal_at(&session, legacy, record_id(), revision(1));
    let before = head.envelope.clone();
    let history = inspect_synthetic_rotation_history_v1(&session, &head, &[&root]).unwrap();
    let event = &history.events()[0];
    assert!(event.recorded_completion() == SyntheticRotationRecordedCompletionV1::Incomplete);
    assert_eq!(event.required_connection_count(), 1);
    assert_eq!(event.completed_connection_count(), 0);
    assert!(event.superseded_revocation_source() == SyntheticRotationRevocationSourceV1::None);
    assert!(head.envelope == before);
}

#[test]
fn fabricated_completion_metadata_cannot_complete_or_clear_generation_0001() {
    let session = session();
    let root = seal_at(&session, plain_item(None), record_id(), revision(0));
    let fabricated_item = event_item(
        revision(0),
        Some((b"DEMO_VALUE_ONLY_API_KEY_0001", "2026-09-16T00:00:00Z")),
        false,
    );
    assert!(fabricated_item.secret_fields[0].value.expose() == b"DEMO_VALUE_ONLY_API_KEY_0001");
    assert!(validate_completed_rotation_event_v1(&fabricated_item).is_err());
    let head = seal_at(&session, fabricated_item, record_id(), revision(1));
    let before = head.envelope.clone();

    let history = inspect_synthetic_rotation_history_v1(&session, &head, &[&root]).unwrap();
    assert_eq!(history.events().len(), 1);
    assert!(
        history.events()[0].recorded_completion()
            == SyntheticRotationRecordedCompletionV1::Incomplete
    );

    let mut edits = 0_u8;
    let mut draws = 0_u8;
    let instrumented =
        crate::persistence::create_synthetic_edited_successor_with_predecessor_and_revision_fill_v1(
            &session,
            &head,
            |_, _| {
                edits += 1;
                Ok(())
            },
            |revision| {
                draws += 1;
                revision.fill(0x74);
                Ok(())
            },
        );
    assert_eq!(error_code(instrumented), LocalVaultErrorCode::InvalidItem);
    assert_eq!(edits, 0);
    assert_eq!(draws, 0);

    let connection_selection = SyntheticConnectionSelectionV1::from_ids(&[0]).unwrap();
    let cutover_selection = SyntheticRotationCutoverSelectionV1::from_fixture_ids(
        &[0],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    assert_eq!(
        error_code(create_synthetic_successor_v1(&session, &head)),
        LocalVaultErrorCode::InvalidItem
    );
    assert_eq!(
        error_code(create_synthetic_connection_successor_v1(
            &session,
            &head,
            &connection_selection,
        )),
        LocalVaultErrorCode::InvalidItem
    );
    assert_eq!(
        error_code(inspect_synthetic_rotation_readiness_v1(
            &session,
            &head,
            &cutover_selection,
        )),
        LocalVaultErrorCode::InvalidItem
    );
    assert_eq!(
        error_code(create_synthetic_rotation_cutover_successor_v1(
            &session,
            &head,
            &cutover_selection,
        )),
        LocalVaultErrorCode::InvalidItem
    );
    assert!(head.envelope == before);
}

#[test]
fn locally_complete_event_that_skips_a_generation_is_reported_incomplete() {
    let session = session();
    let root = seal_at(&session, plain_item(None), record_id(), revision(0));
    let skipped_item = event_item(
        revision(0),
        Some((
            b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0003",
            "2026-09-17T00:00:00Z",
        )),
        true,
    );
    assert!(validate_completed_rotation_event_v1(&skipped_item).is_ok());
    let head = seal_at(&session, skipped_item, record_id(), revision(1));
    let history = inspect_synthetic_rotation_history_v1(&session, &head, &[&root]).unwrap();
    assert_eq!(history.events().len(), 1);
    assert!(
        history.events()[0].recorded_completion()
            == SyntheticRotationRecordedCompletionV1::Incomplete
    );
}

#[test]
fn rejects_unattributed_generation_changes_and_non_initial_roots() {
    let session = session();
    let root = seal_at(&session, plain_item(None), record_id(), revision(0));
    let mut changed_item = plain_item(Some(revision(0)));
    changed_item.secret_fields[0].value =
        crate::secret::SecretValueV1::new(b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0002".to_vec())
            .unwrap();
    let changed = seal_at(&session, changed_item, record_id(), revision(1));
    assert_eq!(
        error_code(inspect_synthetic_rotation_history_v1(
            &session,
            &changed,
            &[&root],
        )),
        LocalVaultErrorCode::InvalidItem
    );

    let mut non_initial_root = plain_item(None);
    non_initial_root.secret_fields[0].value =
        crate::secret::SecretValueV1::new(b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0002".to_vec())
            .unwrap();
    let non_initial_root = seal_at(&session, non_initial_root, record_id(), revision(2));
    assert_eq!(
        error_code(inspect_synthetic_rotation_history_v1(
            &session,
            &non_initial_root,
            &[],
        )),
        LocalVaultErrorCode::InvalidItem
    );
}

#[test]
fn rejects_a_missing_parent_and_duplicate_head_or_ancestor() {
    let session = session();
    let root = seal_at(&session, plain_item(None), record_id(), revision(0));
    let head = seal_at(
        &session,
        plain_item(Some(revision(0))),
        record_id(),
        revision(1),
    );
    for ancestors in [vec![], vec![&root, &root], vec![&root, &head]] {
        assert_eq!(
            error_code(inspect_synthetic_rotation_history_v1(
                &session, &head, &ancestors
            )),
            LocalVaultErrorCode::InvalidItem
        );
    }
}

#[test]
fn rejects_authenticated_foreign_records_and_unused_sibling_branches() {
    let session = session();
    let root = seal_at(&session, plain_item(None), record_id(), revision(0));
    let head = seal_at(
        &session,
        plain_item(Some(revision(0))),
        record_id(),
        revision(1),
    );
    let sibling = seal_at(
        &session,
        plain_item(Some(revision(0))),
        record_id(),
        revision(2),
    );
    let foreign = seal_at(
        &session,
        plain_item(None),
        RecordIdV1::from_bytes([0x47; 16]),
        revision(3),
    );
    for extra in [&sibling, &foreign] {
        assert_eq!(
            error_code(inspect_synthetic_rotation_history_v1(
                &session,
                &head,
                &[&root, extra]
            )),
            LocalVaultErrorCode::InvalidItem
        );
    }
}

#[test]
fn rejects_an_authenticated_multi_revision_parent_cycle() {
    let session = session();
    let first = seal_at(
        &session,
        plain_item(Some(revision(1))),
        record_id(),
        revision(0),
    );
    let second = seal_at(
        &session,
        plain_item(Some(revision(0))),
        record_id(),
        revision(1),
    );
    assert_eq!(
        error_code(inspect_synthetic_rotation_history_v1(
            &session,
            &second,
            &[&first]
        )),
        LocalVaultErrorCode::InvalidItem
    );
}

#[test]
fn authenticates_every_supplied_envelope_and_preserves_tampered_inputs() {
    let session = session();
    let root = seal_at(&session, plain_item(None), record_id(), revision(0));
    let head = seal_at(
        &session,
        plain_item(Some(revision(0))),
        record_id(),
        revision(1),
    );
    let mut bad_ancestor = sealed_from_current_envelope(root.envelope.clone()).unwrap();
    *bad_ancestor.envelope.last_mut().unwrap() ^= 1;
    let ancestor_before = bad_ancestor.envelope.clone();
    assert_eq!(
        error_code(inspect_synthetic_rotation_history_v1(
            &session,
            &head,
            &[&bad_ancestor]
        )),
        LocalVaultErrorCode::AuthenticationFailed
    );
    assert!(bad_ancestor.envelope == ancestor_before);

    let mut bad_head = sealed_from_current_envelope(head.envelope.clone()).unwrap();
    *bad_head.envelope.last_mut().unwrap() ^= 1;
    let head_before = bad_head.envelope.clone();
    assert_eq!(
        error_code(inspect_synthetic_rotation_history_v1(
            &session,
            &bad_head,
            &[&root]
        )),
        LocalVaultErrorCode::AuthenticationFailed
    );
    assert!(bad_head.envelope == head_before);

    // An unused extra must not be silently omitted before authenticating it.
    assert_eq!(
        error_code(inspect_synthetic_rotation_history_v1(
            &session,
            &root,
            &[&bad_head]
        )),
        LocalVaultErrorCode::AuthenticationFailed
    );
}

#[test]
fn a_different_session_cannot_authenticate_the_supplied_chain() {
    let session = session();
    let root = seal_at(&session, plain_item(None), record_id(), revision(0));
    let password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_other_history_vault".to_owned()).unwrap();
    let other = create_vault_v0alpha1(&password).unwrap().session;
    assert_eq!(
        error_code(inspect_synthetic_rotation_history_v1(&other, &root, &[])),
        LocalVaultErrorCode::AuthenticationFailed
    );
}

#[test]
fn canonical_authenticated_envelopes_override_mutated_cached_locators() {
    let session = session();
    let mut root = seal_at(&session, plain_item(None), record_id(), revision(0));
    let mut head = seal_at(
        &session,
        event_item(
            revision(0),
            Some((
                b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0002",
                "2026-09-16T00:00:00Z",
            )),
            true,
        ),
        record_id(),
        revision(1),
    );
    for record in [&mut root, &mut head] {
        record.vault_commitment = [0x99; 32];
        record.locator.record_id = RecordIdV1::from_bytes([0x99; 16]);
        record.locator.revision_id = revision(90);
        record.locator.key_epoch = u32::MAX;
        record.locator.padding_bucket = StoredPaddingBucketV0Alpha1::Bytes61440;
    }
    let before = head.envelope.clone();
    let history = inspect_synthetic_rotation_history_v1(&session, &head, &[&root]).unwrap();
    assert!(history.events()[0].revision_id() == revision(1));
    assert!(history.events()[0].parent_revision_id() == revision(0));
    assert!(head.envelope == before);
}

#[test]
fn future_inner_and_outer_versions_are_rejected_without_modifying_their_bytes() {
    let session = session();
    let inner = seal_synthetic_future_inner_v2(&session).unwrap();
    let mut outer = seal_at(&session, plain_item(None), record_id(), revision(0));
    assert_eq!(outer.envelope[0], 0x8c);
    assert_eq!(outer.envelope[1], 0);
    outer.envelope[1] = 1;
    for future in [&inner, &outer] {
        let before = future.envelope.clone();
        assert_eq!(
            error_code(inspect_synthetic_rotation_history_v1(&session, future, &[])),
            LocalVaultErrorCode::CryptoFailure
        );
        assert!(future.envelope == before);
    }
}

#[test]
fn accepts_exactly_512_authenticated_revisions_and_rejects_the_next_before_authentication() {
    let session = session();
    let records: Vec<_> = (0..MAX_HISTORY_REVISIONS)
        .map(|index| {
            let parent = index
                .checked_sub(1)
                .map(|previous| revision(previous as u16));
            seal_at(
                &session,
                plain_item(parent),
                record_id(),
                revision(index as u16),
            )
        })
        .collect();
    let head = &records[MAX_HISTORY_REVISIONS - 1];
    let ancestors: Vec<_> = records[..MAX_HISTORY_REVISIONS - 1].iter().collect();
    assert!(
        inspect_synthetic_rotation_history_v1(&session, head, &ancestors)
            .unwrap()
            .events()
            .is_empty()
    );
    let too_many = vec![head; MAX_HISTORY_REVISIONS];
    assert_eq!(
        error_code(inspect_synthetic_rotation_history_v1(
            &session, head, &too_many
        )),
        LocalVaultErrorCode::LimitsExceeded
    );
}

#[test]
fn enforces_the_aggregate_ciphertext_limit_before_parsing_any_envelope() {
    let session = session();
    let mut head = seal_at(&session, plain_item(None), record_id(), revision(0));
    head.envelope.resize(MAX_HISTORY_CIPHERTEXT_BYTES, 0);
    assert!(validate_history_size_limits(&head, &[]).is_ok());
    assert_eq!(
        error_code(validate_history_size_limits(&head, &[&head])),
        LocalVaultErrorCode::LimitsExceeded
    );
    head.envelope.push(0);
    let before_length = head.envelope.len();
    assert_eq!(
        error_code(inspect_synthetic_rotation_history_v1(&session, &head, &[])),
        LocalVaultErrorCode::LimitsExceeded
    );
    assert_eq!(head.envelope.len(), before_length);
}
