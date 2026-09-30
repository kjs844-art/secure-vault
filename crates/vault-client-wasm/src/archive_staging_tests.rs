use std::sync::OnceLock;

use vault_local_core::{SyntheticRotationChecklistGenerationV1, SyntheticVerificationEvidenceV1};

use super::*;

const PENDING: SyntheticRotationStageRevocationV1 = SyntheticRotationStageRevocationV1::Pending;
const USER: SyntheticRotationStageRevocationV1 = SyntheticRotationStageRevocationV1::UserConfirmed;

fn fixture() -> &'static [u8] {
    static FIXTURE: OnceLock<Vec<u8>> = OnceLock::new();
    FIXTURE.get_or_init(|| create_archive().unwrap())
}

fn partial() -> &'static [u8] {
    static FIXTURE: OnceLock<Vec<u8>> = OnceLock::new();
    FIXTURE
        .get_or_init(|| create_rotation_stage_candidate(fixture(), 2, &[0], &[], PENDING).unwrap())
}

fn ready() -> &'static [u8] {
    static FIXTURE: OnceLock<Vec<u8>> = OnceLock::new();
    FIXTURE.get_or_init(|| create_rotation_stage_candidate(partial(), 2, &[0], &[1], USER).unwrap())
}

fn finalized() -> &'static [u8] {
    static FIXTURE: OnceLock<Vec<u8>> = OnceLock::new();
    FIXTURE.get_or_init(|| create_rotation_cutover_from_stage_candidate(ready(), 2).unwrap())
}

fn assert_rejected(bytes: &[u8], expected: ArchiveError) {
    let preserved = bytes.to_vec();
    assert_eq!(open_archive(bytes).err(), Some(expected));
    assert_eq!(inspect_rotation_stage(bytes, 2).err(), Some(expected));
    assert_eq!(
        create_rotation_stage_candidate(bytes, 2, &[0], &[], PENDING).err(),
        Some(expected)
    );
    assert_eq!(
        create_rotation_cutover_from_stage_candidate(bytes, 2).err(),
        Some(expected)
    );
    assert_eq!(bytes, preserved);
}

#[test]
fn save_reopen_update_and_finalize_preserves_siblings_until_head_cas_candidate() {
    let original = parse_archive(fixture()).unwrap();
    let first = parse_archive(partial()).unwrap();
    let second = parse_archive(ready()).unwrap();
    assert_eq!(first.version, STAGING_ARCHIVE_VERSION);
    assert_eq!(original.password_envelope, first.password_envelope);
    assert_eq!(original.records, first.records);
    assert_eq!(original.heads, first.heads);
    assert_eq!(first.records, second.records);
    assert_eq!(first.heads, second.heads);
    assert_eq!(first.stages, second.stages[..1]);
    assert_eq!(second.stages.len(), 2);
    assert!(
        second
            .stages
            .iter()
            .all(|stage| stage.base_index == original.heads[2])
    );
    assert_eq!(open_archive(partial()).unwrap().len(), 3);

    let reopened = inspect_rotation_stage(partial(), 2).unwrap().unwrap();
    assert!(reopened.base_generation() == SyntheticRotationChecklistGenerationV1::Initial0001);
    assert!(reopened.target_generation() == SyntheticRotationChecklistGenerationV1::Rotated0002);
    assert_eq!(reopened.remaining_optional(), 2);
    assert!(!reopened.ready_for_cutover());
    assert!(reopened.revocation() == PENDING);
    assert_eq!(
        create_rotation_cutover_from_stage_candidate(partial(), 2).err(),
        Some(ArchiveError::InvalidArchive)
    );
    let reopened = inspect_rotation_stage(ready(), 2).unwrap().unwrap();
    assert!(reopened.ready_for_cutover());
    assert_eq!(reopened.remaining_optional(), 1);

    let final_frame = parse_archive(finalized()).unwrap();
    assert_eq!(final_frame.version, STAGING_ARCHIVE_VERSION);
    assert_eq!(second.stages, final_frame.stages);
    assert_eq!(second.records, final_frame.records[..second.records.len()]);
    assert_eq!(final_frame.records.len(), second.records.len() + 1);
    assert_eq!(final_frame.heads[2], second.records.len());
    assert_eq!(final_frame.heads[..2], second.heads[..2]);
    assert!(inspect_rotation_stage(finalized(), 2).unwrap().is_none());
    assert_eq!(
        create_rotation_cutover_from_stage_candidate(finalized(), 2).err(),
        Some(ArchiveError::InvalidArchive)
    );
}

#[test]
fn migration_from_each_legacy_version_preserves_every_encrypted_byte() {
    let v2 = append_registration(fixture(), 0, 0, &[]).unwrap();
    let v3 = edit_connections(fixture(), 1, &[0, 1]).unwrap();
    for input in [fixture(), v2.as_slice(), v3.as_slice()] {
        assert!(inspect_rotation_stage(input, 2).unwrap().is_none());
        let before = parse_archive(input).unwrap();
        let bytes = create_rotation_stage_candidate(input, 2, &[], &[], PENDING).unwrap();
        let after = parse_archive(&bytes).unwrap();
        assert_eq!(after.version, 4);
        assert_eq!(before.password_envelope, after.password_envelope);
        assert_eq!(before.records, after.records);
        assert_eq!(before.heads, after.heads);
        assert_eq!(after.stages.len(), 1);
        assert!(inspect_rotation_stage(&bytes, 2).unwrap().is_some());
    }
}

#[test]
fn append_edit_and_one_shot_cutover_keep_v4_and_every_stage() {
    let appended = append_registration(partial(), 1, 0, &[0]).unwrap();
    let edited = edit_connections(partial(), 2, &[0, 2]).unwrap();
    let cutover = create_rotation_cutover_candidate(
        partial(),
        2,
        &[0],
        &[],
        SyntheticVerificationEvidenceV1::UserConfirmed,
    )
    .unwrap();
    let before = parse_archive(partial()).unwrap();
    for bytes in [&appended, &edited, &cutover] {
        let after = parse_archive(bytes).unwrap();
        assert_eq!(after.version, STAGING_ARCHIVE_VERSION);
        assert_eq!(after.stages, before.stages);
        assert_eq!(after.records[..before.records.len()], before.records);
        open_archive(bytes).unwrap();
    }
    assert!(inspect_rotation_stage(&appended, 2).unwrap().is_some());
    assert!(inspect_rotation_stage(&edited, 2).unwrap().is_none());
    assert!(inspect_rotation_stage(&cutover, 2).unwrap().is_none());
}

#[test]
fn next_rotation_stages_use_new_canonical_head_and_terminal_cannot_stage() {
    let next = create_rotation_stage_candidate(finalized(), 2, &[0, 1], &[], USER).unwrap();
    let before = parse_archive(finalized()).unwrap();
    let staged = parse_archive(&next).unwrap();
    assert_eq!(staged.stages.last().unwrap().base_index, before.heads[2]);
    let progress = inspect_rotation_stage(&next, 2).unwrap().unwrap();
    assert!(progress.base_generation() == SyntheticRotationChecklistGenerationV1::Rotated0002);
    assert!(progress.target_generation() == SyntheticRotationChecklistGenerationV1::Terminal0003);
    let terminal = create_rotation_cutover_from_stage_candidate(&next, 2).unwrap();
    assert!(inspect_rotation_stage(&terminal, 2).unwrap().is_none());
    assert_eq!(
        create_rotation_stage_candidate(&terminal, 2, &[], &[], PENDING).err(),
        Some(ArchiveError::InvalidArchive)
    );
}

#[test]
fn invalid_inactive_stage_rejects_catalog_and_all_stage_operations() {
    let parsed = parse_archive(finalized()).unwrap();
    let mut corrupt = parsed.stages[0].envelope.to_vec();
    *corrupt.last_mut().unwrap() ^= 1;
    let mut stages = parsed.stages.clone();
    stages[0].envelope = &corrupt;
    let bytes = encode(
        parsed.password_envelope,
        &parsed.records,
        &parsed.heads,
        &stages,
    )
    .unwrap();
    assert_rejected(&bytes, ArchiveError::AuthenticationFailed);
    stages[0].envelope = &[0x81, 0x01];
    let future = encode(
        parsed.password_envelope,
        &parsed.records,
        &parsed.heads,
        &stages,
    )
    .unwrap();
    assert_rejected(&future, ArchiveError::UpgradeRequired);
    stages[0].envelope = &[0];
    let invalid = encode(
        parsed.password_envelope,
        &parsed.records,
        &parsed.heads,
        &stages,
    )
    .unwrap();
    assert_rejected(&invalid, ArchiveError::InvalidArchive);
}

#[test]
fn duplicate_revision_ids_and_wrong_authenticated_base_indexes_are_rejected() {
    let parsed = parse_archive(partial()).unwrap();
    let duplicate = encode(
        parsed.password_envelope,
        &parsed.records,
        &parsed.heads,
        &[parsed.stages[0], parsed.stages[0]],
    )
    .unwrap();
    assert_rejected(&duplicate, ArchiveError::InvalidArchive);
    let canonical_collision = [StagedEnvelope {
        base_index: 2,
        envelope: parsed.records[2],
    }];
    let collision = encode(
        parsed.password_envelope,
        &parsed.records,
        &parsed.heads,
        &canonical_collision,
    )
    .unwrap();
    assert_rejected(&collision, ArchiveError::InvalidArchive);
    let wrong_base = [StagedEnvelope {
        base_index: 1,
        envelope: parsed.stages[0].envelope,
    }];
    let wrong = encode(
        parsed.password_envelope,
        &parsed.records,
        &parsed.heads,
        &wrong_base,
    )
    .unwrap();
    assert_rejected(&wrong, ArchiveError::InvalidArchive);
    let advanced = parse_archive(finalized()).unwrap();
    let wrong_parent = [StagedEnvelope {
        base_index: advanced.heads[2],
        envelope: advanced.stages[0].envelope,
    }];
    let wrong = encode(
        advanced.password_envelope,
        &advanced.records,
        &advanced.heads,
        &wrong_parent,
    )
    .unwrap();
    assert_rejected(&wrong, ArchiveError::InvalidArchive);
}

#[test]
fn latest_sibling_order_is_local_progress_not_automatic_best_or_ready_selection() {
    let parsed = parse_archive(ready()).unwrap();
    let stages = [parsed.stages[1], parsed.stages[0]];
    let reordered = encode(
        parsed.password_envelope,
        &parsed.records,
        &parsed.heads,
        &stages,
    )
    .unwrap();
    let progress = inspect_rotation_stage(&reordered, 2).unwrap().unwrap();
    assert!(!progress.ready_for_cutover());
    assert_eq!(progress.remaining_optional(), 2);
    assert_eq!(
        create_rotation_cutover_from_stage_candidate(&reordered, 2).err(),
        Some(ArchiveError::InvalidArchive)
    );
}

#[test]
fn encrypted_stage_cannot_be_reframed_as_a_canonical_head() {
    for input in [partial(), ready()] {
        let parsed = parse_archive(input).unwrap();
        let mut records = parsed.records.clone();
        let mut heads = parsed.heads.clone();
        heads[2] = records.len();
        records.push(parsed.stages.last().unwrap().envelope);
        // Its IDs and parent form a linear authenticated chain. v4 additionally
        // requires every canonical event to be completed, not a progress sibling.
        let reframed = encode(parsed.password_envelope, &records, &heads, &[]).unwrap();
        let session =
            unlock_vault_v0alpha1(&demo_password().unwrap(), parsed.password_envelope).unwrap();
        history::validate(&session, &parse_archive(&reframed).unwrap()).unwrap();
        assert_rejected(&reframed, ArchiveError::InvalidArchive);
        // An unrelated selected head must not hide the invalid canonical head.
        assert_eq!(
            inspect_rotation_stage(&reframed, 0).err(),
            Some(ArchiveError::InvalidArchive)
        );
    }
}

#[test]
fn required_connection_and_revocation_must_both_be_saved_before_finalization() {
    let pending = create_rotation_stage_candidate(fixture(), 1, &[], &[], PENDING).unwrap();
    let progress = inspect_rotation_stage(&pending, 1).unwrap().unwrap();
    assert_eq!(progress.remaining_required(), 1);
    assert!(!progress.ready_for_cutover());
    assert_eq!(
        create_rotation_cutover_from_stage_candidate(&pending, 1).err(),
        Some(ArchiveError::InvalidArchive)
    );
    assert_eq!(
        create_rotation_stage_candidate(&pending, 1, &[], &[], USER).err(),
        Some(ArchiveError::InvalidArchive)
    );
    let verified = create_rotation_stage_candidate(&pending, 1, &[0], &[], PENDING).unwrap();
    let progress = inspect_rotation_stage(&verified, 1).unwrap().unwrap();
    assert_eq!(progress.remaining_required(), 0);
    assert!(!progress.ready_for_cutover());
    assert_eq!(
        create_rotation_cutover_from_stage_candidate(&verified, 1).err(),
        Some(ArchiveError::InvalidArchive)
    );
    let ready = create_rotation_stage_candidate(&verified, 1, &[0], &[], USER).unwrap();
    let completed = create_rotation_cutover_from_stage_candidate(&ready, 1).unwrap();
    assert!(inspect_rotation_stage(&completed, 1).unwrap().is_none());
}

#[test]
fn malformed_v4_counts_indexes_truncation_and_future_version_fail_before_unlock() {
    for (range, count, expected) in [
        (16..20, 513_u32, ArchiveError::LimitsExceeded),
        (20..24, 510_u32, ArchiveError::LimitsExceeded),
        (16..20, 2_u32, ArchiveError::InvalidArchive),
        (12..16, 129_u32, ArchiveError::LimitsExceeded),
        (8..12, 5_u32, ArchiveError::UpgradeRequired),
    ] {
        let mut bytes = partial().to_vec();
        bytes[range].copy_from_slice(&count.to_le_bytes());
        assert_eq!(parse_archive(&bytes).err(), Some(expected));
    }
    for end in [20, 23, partial().len() - 1] {
        assert_eq!(
            parse_archive(&partial()[..end]).err(),
            Some(ArchiveError::InvalidArchive)
        );
    }
    let mut trailing = partial().to_vec();
    trailing.push(0);
    assert_eq!(
        parse_archive(&trailing).err(),
        Some(ArchiveError::InvalidArchive)
    );
    let parsed = parse_archive(partial()).unwrap();
    let stage_offset = partial().len() - parsed.stages[0].envelope.len() - 8;
    let mut invalid_base = partial().to_vec();
    invalid_base[stage_offset..stage_offset + 4].copy_from_slice(&3_u32.to_le_bytes());
    assert_eq!(
        parse_archive(&invalid_base).err(),
        Some(ArchiveError::InvalidArchive)
    );
}

#[test]
fn v4_encoder_shares_canonical_and_stage_count_and_byte_budgets() {
    let records = [&[1][..]; 3];
    let mut stages = vec![
        StagedEnvelope {
            base_index: 0,
            envelope: &[1]
        };
        MAX_REVISION_COUNT - 3
    ];
    let bounded = encode(&[1], &records, &[0, 1, 2], &stages).unwrap();
    assert_eq!(
        parse_archive(&bounded).unwrap().stages.len(),
        MAX_REVISION_COUNT - 3
    );
    stages.push(stages[0]);
    assert_eq!(
        encode(&[1], &records, &[0, 1, 2], &stages).err(),
        Some(ArchiveError::LimitsExceeded)
    );
    let too_large = vec![0; MAX_ENVELOPE_BYTES + 1];
    assert_eq!(
        encode(
            &[1],
            &records,
            &[0, 1, 2],
            &[StagedEnvelope {
                base_index: 0,
                envelope: &too_large
            }]
        )
        .err(),
        Some(ArchiveError::LimitsExceeded)
    );
    let maximum = vec![0; MAX_ENVELOPE_BYTES];
    let stages = vec![
        StagedEnvelope {
            base_index: 0,
            envelope: &maximum
        };
        8
    ];
    assert_eq!(
        encode(&[1], &records, &[0, 1, 2], &stages).err(),
        Some(ArchiveError::LimitsExceeded)
    );
}

#[test]
fn stages_never_serialize_plaintext_metadata_selection_or_password() {
    for bytes in [partial(), ready(), finalized()] {
        for marker in [
            DEMO_PASSWORD.as_bytes(),
            b"DEMO_VALUE_ONLY_API_KEY_0001",
            b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0002",
            b"Example AI Workshop",
            b"Example MCP",
            b"user_confirmed",
            b"provider_verified",
        ] {
            assert!(!bytes.windows(marker.len()).any(|window| window == marker));
        }
    }
    assert_eq!(
        create_rotation_stage_candidate(fixture(), 128, &[], &[], PENDING).err(),
        Some(ArchiveError::InvalidArchive)
    );
    assert_eq!(
        create_rotation_stage_candidate(fixture(), 2, &[0], &[0], PENDING).err(),
        Some(ArchiveError::InvalidArchive)
    );
}
