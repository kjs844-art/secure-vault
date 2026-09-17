//! Closed synthetic regressions. Assertions never print decrypted values.

use vault_crypto::{MasterPassword, VaultSession, create_vault_v0alpha1, unlock_vault_v0alpha1};

use super::*;
use crate::model::UtcTimestampV1;
use crate::record::{record_context, sealed_from_current_envelope, select_bucket};
use crate::{
    SyntheticConnectionSelectionV1, SyntheticCredentialFixtureId,
    create_synthetic_connection_successor_v1, create_synthetic_successor_v1,
    inspect_synthetic_rotation_history_v1, seal_synthetic_fixture_v1,
};

fn session() -> VaultSession {
    let password = MasterPassword::from_utf8("DEMO_VALUE_ONLY_stage_tests".to_owned()).unwrap();
    create_vault_v0alpha1(&password).unwrap().session
}

fn base(session: &VaultSession) -> SealedCredentialRecordV0Alpha1 {
    seal_synthetic_fixture_v1(session, SyntheticCredentialFixtureId::SingleMcpConnection).unwrap()
}

fn selection(
    user: &[u32],
    revocation: SyntheticRotationStageRevocationV1,
) -> SyntheticRotationStageSelectionV1 {
    SyntheticRotationStageSelectionV1::from_fixture_ids(user, &[], revocation).unwrap()
}

fn current(bytes: &[u8]) -> SealedCredentialRecordV0Alpha1 {
    sealed_from_current_envelope(bytes.to_vec()).unwrap()
}

fn payload(session: &VaultSession, record: &SealedCredentialRecordV0Alpha1) -> CredentialItemV1 {
    inspect_owned_synthetic_predecessor_v1(session, record, |item, _, _| Ok(item)).unwrap()
}

fn reseal(
    session: &VaultSession,
    record: &SealedCredentialRecordV0Alpha1,
    mutate: impl FnOnce(&mut CredentialItemV1),
) -> Vec<u8> {
    let mut item = payload(session, record);
    mutate(&mut item);
    let plaintext = encode_current_item(&item, record.locator.revision_id).unwrap();
    let context = record_context(
        session,
        record.locator.record_id,
        record.locator.revision_id,
        record.locator.key_epoch,
        select_bucket(plaintext.expose_secret().len()).unwrap(),
    )
    .unwrap();
    vault_crypto::seal_record_v0alpha1(session, &context, &plaintext).unwrap()
}

#[test]
fn partial_snapshots_are_siblings_and_preserve_the_canonical_base() {
    let session = session();
    let base = base(&session);
    let before = base.envelope.clone();
    let first = create_synthetic_rotation_stage_v1(
        &session,
        &base,
        &selection(&[], SyntheticRotationStageRevocationV1::Pending),
    )
    .unwrap();
    let second = create_synthetic_rotation_stage_v1(
        &session,
        &base,
        &selection(&[0], SyntheticRotationStageRevocationV1::Pending),
    )
    .unwrap();
    let first_record = current(first.envelope());
    let second_record = current(second.envelope());
    assert!(first_record.locator.revision_id != second_record.locator.revision_id);
    for stage in [&first_record, &second_record] {
        assert!(stage.locator.record_id == base.locator.record_id);
        let item = payload(&session, stage);
        assert!(item.parent_revision_id == Some(base.locator.revision_id));
        assert!(
            item.rotation_state.as_ref().unwrap().supersedes_revision_id
                == base.locator.revision_id
        );
        assert!(item.status == CredentialStatusV1::Rotating);
        assert!(item.item_schema_version == 1);
    }
    let pending = inspect_synthetic_rotation_stage_v1(&session, &base, first.envelope()).unwrap();
    assert!(pending.base_generation() == SyntheticRotationChecklistGenerationV1::Initial0001);
    assert!(pending.target_generation() == SyntheticRotationChecklistGenerationV1::Rotated0002);
    assert!(pending.remaining_required() == 1 && pending.remaining_optional() == 0);
    assert!(!pending.ready_for_cutover());
    assert!(pending.entries().len() == 1);
    assert!(pending.entries()[0].fixture() == SyntheticRotationChecklistFixtureV1::Mcp);
    assert!(pending.entries()[0].required_for_cutover());
    assert!(pending.entries()[0].completion() == SyntheticRotationStageCompletionV1::Pending);
    let checked = inspect_synthetic_rotation_stage_v1(&session, &base, second.envelope()).unwrap();
    assert!(checked.remaining_required() == 0 && !checked.ready_for_cutover());
    assert!(checked.entries()[0].completion() == SyntheticRotationStageCompletionV1::UserConfirmed);
    assert!(base.envelope == before);
    for marker in [
        b"DEMO_VALUE_ONLY_API_KEY_0001".as_slice(),
        b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0002".as_slice(),
    ] {
        assert!(
            !first
                .envelope()
                .windows(marker.len())
                .any(|window| window == marker)
        );
    }
}

#[test]
fn stored_stage_restores_after_unlock_and_finalizes_as_a_sibling_of_the_original_head() {
    let password = MasterPassword::from_utf8("DEMO_VALUE_ONLY_stage_restart".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let base = base(&created.session);
    let selected = SyntheticRotationStageSelectionV1::from_fixture_ids(
        &[],
        &[0],
        SyntheticRotationStageRevocationV1::ProviderVerified,
    )
    .unwrap();
    let stage = create_synthetic_rotation_stage_v1(&created.session, &base, &selected).unwrap();
    let stage_bytes = stage.envelope().to_vec();
    let base_bytes = base.envelope.clone();
    drop(stage);
    drop(created.session);
    let reopened = unlock_vault_v0alpha1(&password, &created.password_envelope).unwrap();
    let restored = inspect_synthetic_rotation_stage_v1(&reopened, &base, &stage_bytes).unwrap();
    assert!(restored.ready_for_cutover());
    assert!(restored.revocation() == SyntheticRotationStageRevocationV1::ProviderVerified);
    assert!(
        restored.entries()[0].completion() == SyntheticRotationStageCompletionV1::ProviderVerified
    );
    let final_candidate =
        create_synthetic_rotation_cutover_from_stage_v1(&reopened, &base, &stage_bytes).unwrap();
    let final_projection = final_candidate.persistence_projection_v1();
    assert!(final_projection.expected_revision_id() == Some(base.locator.revision_id));
    let final_record = current(final_projection.envelope());
    let final_item = payload(&reopened, &final_record);
    assert!(final_item.status == CredentialStatusV1::Active);
    assert!(final_item.parent_revision_id == Some(base.locator.revision_id));
    let history =
        inspect_synthetic_rotation_history_v1(&reopened, &final_record, &[&base]).unwrap();
    assert!(history.events().len() == 1);
    assert!(
        history.events()[0].recorded_completion()
            == crate::SyntheticRotationRecordedCompletionV1::Complete
    );
    assert!(base.envelope == base_bytes);
    assert!(inspect_synthetic_rotation_stage_v1(&reopened, &base, &stage_bytes).is_ok());
    assert!(inspect_synthetic_rotation_stage_v1(&reopened, &final_record, &stage_bytes).is_err());
}

#[test]
fn revocation_requires_all_required_connections_and_pending_never_finalizes() {
    let session = session();
    let base = base(&session);
    for revocation in [
        SyntheticRotationStageRevocationV1::UserConfirmed,
        SyntheticRotationStageRevocationV1::ProviderVerified,
    ] {
        assert!(
            create_synthetic_rotation_stage_v1(&session, &base, &selection(&[], revocation))
                .is_err()
        );
    }
    for user in [&[][..], &[0][..]] {
        let pending = create_synthetic_rotation_stage_v1(
            &session,
            &base,
            &selection(user, SyntheticRotationStageRevocationV1::Pending),
        )
        .unwrap();
        assert!(
            create_synthetic_rotation_cutover_from_stage_v1(&session, &base, pending.envelope())
                .is_err()
        );
    }
}

#[test]
fn stages_cannot_be_used_as_generic_heads_or_direct_cutovers() {
    let session = session();
    let base = base(&session);
    for revocation in [
        SyntheticRotationStageRevocationV1::Pending,
        SyntheticRotationStageRevocationV1::UserConfirmed,
    ] {
        let stage =
            create_synthetic_rotation_stage_v1(&session, &base, &selection(&[0], revocation))
                .unwrap();
        let staged_record = current(stage.envelope());
        assert!(create_synthetic_successor_v1(&session, &staged_record).is_err());
        assert!(
            create_synthetic_connection_successor_v1(
                &session,
                &staged_record,
                &SyntheticConnectionSelectionV1::from_ids(&[0]).unwrap()
            )
            .is_err()
        );
        assert!(
            create_synthetic_rotation_cutover_successor_v1(
                &session,
                &staged_record,
                &SyntheticRotationCutoverSelectionV1::from_fixture_ids(
                    &[0],
                    &[],
                    SyntheticVerificationEvidenceV1::UserConfirmed
                )
                .unwrap()
            )
            .is_err()
        );
        assert!(
            create_synthetic_rotation_stage_v1(
                &session,
                &staged_record,
                &selection(&[0], revocation)
            )
            .is_err()
        );
    }
}

#[test]
fn exact_authenticated_pair_rejects_wrong_record_stale_base_and_mutated_payload_fields() {
    let session = session();
    let base = base(&session);
    let stage = create_synthetic_rotation_stage_v1(
        &session,
        &base,
        &selection(&[0], SyntheticRotationStageRevocationV1::UserConfirmed),
    )
    .unwrap();
    let wrong_base = self::base(&session);
    assert!(inspect_synthetic_rotation_stage_v1(&session, &wrong_base, stage.envelope()).is_err());
    let stage_record = current(stage.envelope());
    for mutation in 0..12 {
        let changed = reseal(&session, &stage_record, |item| match mutation {
            0 => item.item_name.push_str(" changed"),
            1 => item.notes = Some("DEMO_VALUE_ONLY_changed_note".to_owned()),
            2 => item.issuer_account_identifier = Some("DEMO_VALUE_ONLY_other_account".to_owned()),
            3 => item.connections[0].notes = Some("DEMO_VALUE_ONLY_changed_connection".to_owned()),
            4 => {
                item.secret_fields[0].value =
                    SecretValueV1::new(b"DEMO_VALUE_ONLY_wrong_generation".to_vec()).unwrap()
            }
            5 => item.secret_fields[0].label.push_str(" changed"),
            6 => item.updated_at = UtcTimestampV1::new("2026-09-18T00:00:00Z".to_owned()).unwrap(),
            7 => item.connections[0].last_verified_at = None,
            8 => item
                .rotation_state
                .as_mut()
                .unwrap()
                .completed_connection_ids
                .clear(),
            9 => item.rotation_state.as_mut().unwrap().superseded_revoked_at = None,
            10 => item.status = CredentialStatusV1::Active,
            11 => item.tags.push("DEMO_VALUE_ONLY_tag".to_owned()),
            _ => unreachable!(),
        });
        assert!(
            inspect_synthetic_rotation_stage_v1(&session, &base, &changed).is_err(),
            "mutation {mutation}"
        );
        assert!(
            create_synthetic_rotation_cutover_from_stage_v1(&session, &base, &changed).is_err(),
            "mutation {mutation}"
        );
    }
}

#[test]
fn pair_authentication_ignores_cached_base_locator_but_not_its_ciphertext() {
    let session = session();
    let mut base = base(&session);
    let other = self::base(&session);
    let stage = create_synthetic_rotation_stage_v1(
        &session,
        &base,
        &selection(&[], SyntheticRotationStageRevocationV1::Pending),
    )
    .unwrap();
    base.locator.record_id = other.locator.record_id;
    base.locator.revision_id = other.locator.revision_id;
    assert!(inspect_synthetic_rotation_stage_v1(&session, &base, stage.envelope()).is_ok());
    let last = base.envelope.len() - 1;
    base.envelope[last] ^= 1;
    assert!(inspect_synthetic_rotation_stage_v1(&session, &base, stage.envelope()).is_err());
}

#[test]
fn optional_completion_is_retained_and_does_not_block_ready_cutover() {
    let session = session();
    let base = seal_synthetic_fixture_v1(&session, SyntheticCredentialFixtureId::MultipleConsumers)
        .unwrap();
    let item = payload(&session, &base);
    let profile = ConnectionProfile::from_item(&item).unwrap();
    let mut required = Vec::new();
    for connection in &item.connections {
        if connection.required_for_cutover {
            required.push(match profile.classify(connection).unwrap() {
                ConnectionFixture::Mcp => 0,
                ConnectionFixture::Cli => 1,
                ConnectionFixture::Ci => 2,
            });
        }
    }
    let stage = create_synthetic_rotation_stage_v1(
        &session,
        &base,
        &selection(&required, SyntheticRotationStageRevocationV1::UserConfirmed),
    )
    .unwrap();
    let projection =
        inspect_synthetic_rotation_stage_v1(&session, &base, stage.envelope()).unwrap();
    assert!(projection.entries().len() == 3 && projection.remaining_required() == 0);
    assert!(projection.remaining_optional() > 0 && projection.ready_for_cutover());
    assert!(
        create_synthetic_rotation_cutover_from_stage_v1(&session, &base, stage.envelope()).is_ok()
    );
}

#[test]
fn second_generation_staging_works_and_terminal_generation_is_rejected() {
    let session = session();
    let first = base(&session);
    let selected = selection(&[0], SyntheticRotationStageRevocationV1::UserConfirmed);
    let stage1 = create_synthetic_rotation_stage_v1(&session, &first, &selected).unwrap();
    let second =
        create_synthetic_rotation_cutover_from_stage_v1(&session, &first, stage1.envelope())
            .unwrap();
    let second = current(second.persistence_projection_v1().envelope());
    let stage2 = create_synthetic_rotation_stage_v1(&session, &second, &selected).unwrap();
    let projection =
        inspect_synthetic_rotation_stage_v1(&session, &second, stage2.envelope()).unwrap();
    assert!(projection.base_generation() == SyntheticRotationChecklistGenerationV1::Rotated0002);
    assert!(projection.target_generation() == SyntheticRotationChecklistGenerationV1::Terminal0003);
    let third =
        create_synthetic_rotation_cutover_from_stage_v1(&session, &second, stage2.envelope())
            .unwrap();
    let third = current(third.persistence_projection_v1().envelope());
    let history =
        inspect_synthetic_rotation_history_v1(&session, &third, &[&second, &first]).unwrap();
    assert!(history.events().len() == 2);
    assert!(create_synthetic_rotation_stage_v1(&session, &third, &selected).is_err());
}

#[test]
fn closed_selection_and_envelope_bounds_reject_invalid_inputs_without_changes() {
    let session = session();
    let base = base(&session);
    let before = base.envelope.clone();
    for (user, provider) in [
        (&[0, 0][..], &[][..]),
        (&[0][..], &[0][..]),
        (&[3][..], &[][..]),
        (&[0, 1, 2, 3][..], &[][..]),
    ] {
        assert!(
            SyntheticRotationStageSelectionV1::from_fixture_ids(
                user,
                provider,
                SyntheticRotationStageRevocationV1::Pending
            )
            .is_err()
        );
    }
    assert!(
        create_synthetic_rotation_stage_v1(
            &session,
            &base,
            &selection(&[1], SyntheticRotationStageRevocationV1::Pending)
        )
        .is_err()
    );
    let future = crate::record::seal_synthetic_future_inner_v2(&session).unwrap();
    for bytes in [&[][..], &[0][..], future.envelope.as_slice()] {
        assert!(inspect_synthetic_rotation_stage_v1(&session, &base, bytes).is_err());
    }
    assert!(inspect_synthetic_rotation_stage_v1(&session, &base, &vec![0; 65_537]).is_err());
    assert!(base.envelope == before);
}
