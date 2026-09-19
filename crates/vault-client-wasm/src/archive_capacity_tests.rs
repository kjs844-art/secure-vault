use std::sync::OnceLock;

use vault_local_core::{
    OwnedRehydratedCredentialV1, SyntheticRotationStageRevocationV1,
    SyntheticRotationStageSelectionV1, SyntheticVerificationEvidenceV1,
    create_synthetic_rotation_stage_v1, create_synthetic_successor_v1,
};

use super::*;

const PENDING: SyntheticRotationStageRevocationV1 = SyntheticRotationStageRevocationV1::Pending;
const USER: SyntheticRotationStageRevocationV1 = SyntheticRotationStageRevocationV1::UserConfirmed;

fn owned(session: &vault_crypto::VaultSession, envelope: &[u8]) -> OwnedRehydratedCredentialV1 {
    match CredentialStorageAuthenticatorV1::new(session)
        .rehydrate_owned_stored_credential_v1(envelope.to_vec())
        .unwrap()
    {
        OwnedRehydratedCredentialOutcomeV1::Current(record) => record,
        OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(_) => {
            panic!("fixture became future data")
        }
    }
}

#[test]
fn count_and_bytes_reservations_accept_exact_bounds_and_reject_one_over() {
    let mut reservation = CompletionReservation::default();
    reservation.add_stage_capacity(Some(1_250), 1_250).unwrap();
    reservation.add_stage_capacity(None, 1_250).unwrap();
    assert_eq!(reservation.revisions, 3);
    assert_eq!(reservation.bytes, 1_258 + 1_254 + 1_254);
    assert_eq!(
        reservation.validate_usage(
            MAX_REVISION_COUNT - 3,
            MAX_ARCHIVE_BYTES - reservation.bytes
        ),
        Ok(())
    );
    assert_eq!(
        reservation.validate_usage(MAX_REVISION_COUNT - 2, 1),
        Err(ArchiveError::LimitsExceeded)
    );
    assert_eq!(
        reservation.validate_usage(1, MAX_ARCHIVE_BYTES - reservation.bytes + 1),
        Err(ArchiveError::LimitsExceeded)
    );
    assert_eq!(
        reservation.validate_usage(usize::MAX, 1),
        Err(ArchiveError::LimitsExceeded)
    );
    assert_eq!(
        reservation.validate_usage(1, usize::MAX),
        Err(ArchiveError::LimitsExceeded)
    );
    let empty = CompletionReservation::default();
    assert_eq!(
        empty.validate_usage(MAX_REVISION_COUNT, MAX_ARCHIVE_BYTES),
        Ok(())
    );
    assert_eq!(
        empty.validate_usage(MAX_REVISION_COUNT + 1, 1),
        Err(ArchiveError::LimitsExceeded)
    );
}

#[test]
fn reservation_accumulation_is_bounded_and_uses_different_stage_and_final_framing() {
    let mut ready = CompletionReservation::default();
    ready.add_stage_capacity(None, 1_024).unwrap();
    assert_eq!(
        ready,
        CompletionReservation {
            revisions: 1,
            bytes: 1_028
        }
    );
    let mut pending = CompletionReservation::default();
    pending.add_stage_capacity(Some(4_096), 1_024).unwrap();
    assert_eq!(
        pending,
        CompletionReservation {
            revisions: 2,
            bytes: 4_104 + 1_028
        }
    );
    assert_eq!(
        pending
            .add_stage_capacity(Some(MAX_ENVELOPE_BYTES + 1), 1)
            .err(),
        Some(ArchiveError::LimitsExceeded)
    );
    assert_eq!(
        ready.add_stage_capacity(None, 0).err(),
        Some(ArchiveError::InvalidArchive)
    );
    let mut overflow = CompletionReservation {
        revisions: usize::MAX,
        bytes: 0,
    };
    assert_eq!(
        overflow.add_stage_capacity(None, 1).err(),
        Some(ArchiveError::LimitsExceeded)
    );
    let mut overflow = CompletionReservation {
        revisions: 0,
        bytes: usize::MAX,
    };
    assert_eq!(
        overflow.add_stage_capacity(None, 1).err(),
        Some(ArchiveError::LimitsExceeded)
    );
}

#[test]
fn byte_policy_uses_the_exact_encoded_frame_length_not_an_envelope_estimate() {
    let mut reservation = CompletionReservation::default();
    reservation.add_stage_capacity(Some(1_250), 1_250).unwrap();
    let target = MAX_ARCHIVE_BYTES - reservation.bytes;
    // Framing-only opaque bytes, not authenticated fixtures. Seven maximum
    // envelopes and one remainder exercise exact frame arithmetic cheaply.
    let big = vec![1; MAX_ENVELOPE_BYTES];
    let overhead = 24 + 12 + 5 + 8 * 4;
    let tail = vec![1; target - overhead - 7 * MAX_ENVELOPE_BYTES];
    let mut records = vec![big.as_slice(); 7];
    records.push(&tail);
    let exact = staging::encode(&[1], &records, &[0, 1, 2], &[]).unwrap();
    assert_eq!(exact.len(), target);
    let parsed = parse_archive(&exact).unwrap();
    assert_eq!(
        reservation.validate_usage(parsed.records.len(), exact.len()),
        Ok(())
    );
    let mut one_more = tail.clone();
    one_more.push(1);
    records[7] = &one_more;
    let too_full = staging::encode(&[1], &records, &[0, 1, 2], &[]).unwrap();
    assert_eq!(too_full.len(), target + 1);
    assert_eq!(
        reservation.validate_usage(parsed.records.len(), too_full.len()),
        Err(ArchiveError::LimitsExceeded)
    );
}

/// Build the large fixture with a single password KDF. Old siblings are made
/// directly with one authenticated session, not hundreds of archive API calls.
fn near_full_pending() -> &'static [u8] {
    static FIXTURE: OnceLock<Vec<u8>> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let (created, mut records) = create_parts().unwrap();
        let old_base = owned(&created.session, &records[0]);
        let active_base = owned(&created.session, &records[1]);
        // The filler stages refer to an inactive old canonical base.
        let advanced =
            create_synthetic_successor_v1(&created.session, old_base.sealed_record()).unwrap();
        records.push(advanced.persistence_projection_v1().envelope().to_vec());
        let heads = [3, 1, 2];
        let selection =
            SyntheticRotationStageSelectionV1::from_fixture_ids(&[], &[], PENDING).unwrap();
        let pending = create_synthetic_rotation_stage_v1(
            &created.session,
            active_base.sealed_record(),
            &selection,
        )
        .unwrap();
        let capacity = inspect_synthetic_rotation_stage_capacity_v1(
            &created.session,
            active_base.sealed_record(),
            pending.envelope(),
        )
        .unwrap();
        let mut reservation = CompletionReservation::default();
        reservation
            .add_stage_capacity(
                capacity.ready_stage_envelope_bytes(),
                capacity.final_envelope_bytes(),
            )
            .unwrap();
        assert_eq!(reservation.revisions, 2);
        let first_filler = create_synthetic_rotation_stage_v1(
            &created.session,
            old_base.sealed_record(),
            &selection,
        )
        .unwrap();
        let record_refs = records.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let initial_stage = [StagedEnvelope {
            base_index: 1,
            envelope: pending.envelope(),
        }];
        let initial = staging::encode(
            &created.password_envelope,
            &record_refs,
            &heads,
            &initial_stage,
        )
        .unwrap();
        let stride = 8 + first_filler.envelope().len();
        let filler_count = (MAX_ARCHIVE_BYTES - initial.len() - reservation.bytes) / stride;
        assert!(filler_count > 100);
        assert!(records.len() + filler_count + 1 + reservation.revisions <= MAX_REVISION_COUNT);
        let mut fillers = vec![first_filler];
        while fillers.len() < filler_count {
            let filler = create_synthetic_rotation_stage_v1(
                &created.session,
                old_base.sealed_record(),
                &selection,
            )
            .unwrap();
            assert_eq!(filler.envelope().len() + 8, stride);
            fillers.push(filler);
        }
        let mut stages = initial_stage.to_vec();
        stages.extend(fillers.iter().map(|filler| StagedEnvelope {
            base_index: 0,
            envelope: filler.envelope(),
        }));
        let bytes =
            staging::encode(&created.password_envelope, &record_refs, &heads, &stages).unwrap();
        let parsed = parse_archive(&bytes).unwrap();
        validate_candidate(&created.session, &parsed, bytes.len()).unwrap();
        assert!(MAX_ARCHIVE_BYTES - bytes.len() - reservation.bytes < stride);
        bytes
    })
}

#[test]
fn pending_at_capacity_rejects_unrelated_writes_but_ready_then_final_consumes_reservation() {
    let before = near_full_pending().to_vec();
    assert_eq!(open_archive(&before).unwrap().len(), 3);
    assert_eq!(
        append_registration(&before, 0, 0, &[]).err(),
        Some(ArchiveError::LimitsExceeded)
    );
    assert_eq!(
        edit_connections(&before, 0, &[0, 1, 2]).err(),
        Some(ArchiveError::LimitsExceeded)
    );
    assert_eq!(
        create_rotation_cutover_candidate(
            &before,
            2,
            &[0, 1, 2],
            &[],
            SyntheticVerificationEvidenceV1::UserConfirmed
        )
        .err(),
        Some(ArchiveError::LimitsExceeded)
    );
    assert_eq!(
        create_rotation_stage_candidate(&before, 1, &[], &[], PENDING).err(),
        Some(ArchiveError::LimitsExceeded)
    );
    assert_eq!(near_full_pending(), before);

    let ready = create_rotation_stage_candidate(&before, 1, &[0], &[], USER).unwrap();
    assert!(
        inspect_rotation_stage(&ready, 1)
            .unwrap()
            .unwrap()
            .ready_for_cutover()
    );
    let preserved_ready = ready.clone();
    // Moving back to Pending needs two future slots again. The previously
    // saved ready sibling must survive a failed reservation increase.
    assert_eq!(
        create_rotation_stage_candidate(&ready, 1, &[], &[], PENDING).err(),
        Some(ArchiveError::LimitsExceeded)
    );
    assert_eq!(ready, preserved_ready);
    let final_bytes = create_rotation_cutover_from_stage_candidate(&ready, 1).unwrap();
    assert!(inspect_rotation_stage(&final_bytes, 1).unwrap().is_none());
    let original = parse_archive(&before).unwrap();
    let final_frame = parse_archive(&final_bytes).unwrap();
    assert_eq!(final_frame.records.len(), original.records.len() + 1);
    assert_eq!(final_frame.stages.len(), original.stages.len() + 1);
    assert_eq!(final_frame.stages[..original.stages.len()], original.stages);
    assert_eq!(
        final_frame.records[..original.records.len()],
        original.records
    );
    assert!(final_bytes.len() <= MAX_ARCHIVE_BYTES);
}

#[test]
fn changing_own_head_releases_its_reservation_without_deleting_history() {
    for bytes in [
        edit_connections(near_full_pending(), 1, &[0]).unwrap(),
        create_rotation_cutover_candidate(
            near_full_pending(),
            1,
            &[0],
            &[],
            SyntheticVerificationEvidenceV1::UserConfirmed,
        )
        .unwrap(),
    ] {
        let before = parse_archive(near_full_pending()).unwrap();
        let after = parse_archive(&bytes).unwrap();
        assert_eq!(after.stages, before.stages);
        assert_eq!(after.records.len(), before.records.len() + 1);
        assert_ne!(after.heads[1], before.heads[1]);
        assert!(inspect_rotation_stage(&bytes, 1).unwrap().is_none());
    }
}

#[test]
fn older_valid_v4_without_completion_headroom_remains_readable_and_preserved() {
    let parsed = parse_archive(near_full_pending()).unwrap();
    let session =
        unlock_vault_v0alpha1(&demo_password().unwrap(), parsed.password_envelope).unwrap();
    let base = owned(&session, parsed.records[parsed.heads[1]]);
    let selection = SyntheticRotationStageSelectionV1::from_fixture_ids(&[], &[], PENDING).unwrap();
    let extra =
        create_synthetic_rotation_stage_v1(&session, base.sealed_record(), &selection).unwrap();
    let mut stages = parsed.stages.clone();
    stages.push(StagedEnvelope {
        base_index: parsed.heads[1],
        envelope: extra.envelope(),
    });
    // Direct framing represents a valid older writer with no reservation policy.
    let old = staging::encode(
        parsed.password_envelope,
        &parsed.records,
        &parsed.heads,
        &stages,
    )
    .unwrap();
    let preserved = old.clone();
    assert_eq!(open_archive(&old).unwrap().len(), 3);
    assert!(inspect_rotation_stage(&old, 1).unwrap().is_some());
    assert_eq!(
        verify_candidate(&session, old.clone()).err(),
        Some(ArchiveError::LimitsExceeded)
    );
    assert_eq!(old, preserved);
}

#[test]
fn all_heads_reserve_only_their_latest_active_stage_and_release_independently() {
    let (created, records) = create_parts().unwrap();
    let bases = records
        .iter()
        .map(|envelope| owned(&created.session, envelope))
        .collect::<Vec<_>>();
    let pending = SyntheticRotationStageSelectionV1::from_fixture_ids(&[], &[], PENDING).unwrap();
    let ready_empty = SyntheticRotationStageSelectionV1::from_fixture_ids(&[], &[], USER).unwrap();
    let ready_mcp = SyntheticRotationStageSelectionV1::from_fixture_ids(&[0], &[], USER).unwrap();
    let old_ready = create_synthetic_rotation_stage_v1(
        &created.session,
        bases[0].sealed_record(),
        &ready_empty,
    )
    .unwrap();
    let latest_pending =
        create_synthetic_rotation_stage_v1(&created.session, bases[0].sealed_record(), &pending)
            .unwrap();
    let ready =
        create_synthetic_rotation_stage_v1(&created.session, bases[1].sealed_record(), &ready_mcp)
            .unwrap();
    let last_pending =
        create_synthetic_rotation_stage_v1(&created.session, bases[2].sealed_record(), &pending)
            .unwrap();
    let stages = [
        StagedEnvelope {
            base_index: 0,
            envelope: old_ready.envelope(),
        },
        StagedEnvelope {
            base_index: 1,
            envelope: ready.envelope(),
        },
        StagedEnvelope {
            base_index: 0,
            envelope: latest_pending.envelope(),
        },
        StagedEnvelope {
            base_index: 2,
            envelope: last_pending.envelope(),
        },
    ];
    let record_refs = records.iter().map(Vec::as_slice).collect::<Vec<_>>();
    let archive = staging::encode(
        &created.password_envelope,
        &record_refs,
        &[0, 1, 2],
        &stages,
    )
    .unwrap();
    let parsed = parse_archive(&archive).unwrap();
    let total = completion_reservation(&created.session, &parsed).unwrap();
    assert_eq!(total.revisions, 5);
    let ready_capacity = inspect_synthetic_rotation_stage_capacity_v1(
        &created.session,
        bases[1].sealed_record(),
        ready.envelope(),
    )
    .unwrap();
    let expected_released_bytes = 4 + ready_capacity.final_envelope_bytes();
    let edited = edit_connections(&archive, 1, &[0]).unwrap();
    let edited_parsed = parse_archive(&edited).unwrap();
    let remaining = completion_reservation(&created.session, &edited_parsed).unwrap();
    assert_eq!(remaining.revisions, 4);
    assert_eq!(remaining.bytes, total.bytes - expected_released_bytes);
    assert_eq!(edited_parsed.stages, parsed.stages);
}
