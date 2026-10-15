use super::super::{append_registration, create_archive, parse_archive};
use super::*;

const USER: SyntheticVerificationEvidenceV1 = SyntheticVerificationEvidenceV1::UserConfirmed;

fn fixture() -> Vec<u8> {
    create_archive().unwrap()
}

fn assert_no_synthetic_plaintext(bytes: &[u8]) {
    let markers: &[&[u8]] = &[
        DEMO_PASSWORD.as_bytes(),
        b"DEMO_VALUE_ONLY_API_KEY_0001",
        b"DEMO_VALUE_ONLY_TOKEN_0002",
        b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0002",
        b"DEMO_VALUE_ONLY_ROTATED_API_KEY_0003",
        b"Example Workshop API Credential",
        b"Example AI Workshop",
        b"Example MCP",
        b"Example CLI",
        b"Example CI",
    ];
    for marker in markers {
        assert!(
            !bytes.windows(marker.len()).any(|window| window == *marker),
            "rotation candidate exposed a synthetic plaintext marker"
        );
    }
}

fn checklist(
    bytes: &[u8],
    reference: u32,
    user_confirmed: &[u32],
    provider_verified: &[u32],
) -> ArchiveRotationChecklistV1 {
    inspect_rotation_checklist(bytes, reference, user_confirmed, provider_verified, USER).unwrap()
}

fn cutover(
    bytes: &[u8],
    reference: u32,
    user_confirmed: &[u32],
    provider_verified: &[u32],
) -> Vec<u8> {
    create_rotation_cutover_candidate(bytes, reference, user_confirmed, provider_verified, USER)
        .unwrap()
}

fn assert_prefix_and_single_head_advance(before: &[u8], after: &[u8], reference: usize) {
    let before = parse_archive(before).unwrap();
    let after = parse_archive(after).unwrap();
    assert_eq!(after.version, HISTORY_ARCHIVE_VERSION);
    assert_eq!(after.password_envelope, before.password_envelope);
    assert_eq!(after.records.len(), before.records.len() + 1);
    assert!(
        before
            .records
            .iter()
            .zip(&after.records)
            .all(|(old, new)| old == new)
    );
    assert_eq!(after.heads.len(), before.heads.len());
    for (index, (&old, &new)) in before.heads.iter().zip(&after.heads).enumerate() {
        assert_eq!(
            new,
            if index == reference {
                before.records.len()
            } else {
                old
            }
        );
    }
}

fn frame_v3(password: &[u8], revisions: &[&[u8]], heads: &[usize]) -> Vec<u8> {
    super::super::history::encode(password, revisions, heads).unwrap()
}

fn assert_rejected_unchanged(bytes: &[u8], expected: ArchiveError) {
    let saved = bytes.to_vec();
    assert_eq!(
        inspect_rotation_checklist(bytes, 0, &[], &[], USER).err(),
        Some(expected)
    );
    assert_eq!(
        create_rotation_cutover_candidate(bytes, 0, &[], &[], USER).err(),
        Some(expected)
    );
    assert_eq!(bytes, saved);
}

#[test]
fn checklist_projects_only_fixed_generation_fixture_requirement_and_readiness() {
    let archive = fixture();
    let pending = checklist(&archive, 1, &[], &[]);
    assert_eq!(
        pending.generation(),
        ArchiveRotationGenerationV1::Initial0001
    );
    assert_eq!(
        pending.readiness_state(),
        ArchiveRotationReadinessStateV1::RequiredPending
    );
    assert_eq!(pending.remaining_required(), 1);
    assert_eq!(pending.remaining_optional(), 0);
    assert_eq!(pending.entries().len(), 1);
    assert_eq!(
        pending.entries()[0].fixture(),
        ArchiveRotationFixtureV1::Mcp
    );
    assert!(pending.entries()[0].required_for_cutover());

    let ready = checklist(&archive, 1, &[0], &[]);
    assert_eq!(
        ready.readiness_state(),
        ArchiveRotationReadinessStateV1::Ready
    );
    assert_eq!(ready.remaining_required(), 0);
    assert_eq!(ready.remaining_optional(), 0);

    let optional = checklist(&archive, 2, &[], &[]);
    assert_eq!(
        optional.readiness_state(),
        ArchiveRotationReadinessStateV1::Ready
    );
    assert_eq!(optional.remaining_required(), 0);
    assert_eq!(optional.remaining_optional(), 3);
    assert_eq!(
        optional
            .entries()
            .iter()
            .map(ArchiveRotationChecklistEntryV1::fixture)
            .collect::<Vec<_>>(),
        [
            ArchiveRotationFixtureV1::Mcp,
            ArchiveRotationFixtureV1::Cli,
            ArchiveRotationFixtureV1::Ci,
        ]
    );
    assert!(
        optional
            .entries()
            .iter()
            .all(|entry| !entry.required_for_cutover())
    );
}

#[test]
fn v1_genesis_cutover_migrates_to_v3_without_rewriting_any_input_envelope() {
    let before = fixture();
    let predecessor_revision = prepare_archive(&before, 0)
        .unwrap()
        .selected
        .head
        .sealed_record()
        .persistence_projection_v1()
        .revision_id();
    let saved = before.clone();
    let after = cutover(&before, 0, &[], &[]);
    assert_eq!(before, saved);
    assert_prefix_and_single_head_advance(&before, &after, 0);
    let projected = checklist(&after, 0, &[], &[]);
    assert_eq!(
        projected.generation(),
        ArchiveRotationGenerationV1::Rotated0002
    );
    assert_eq!(
        projected.readiness_state(),
        ArchiveRotationReadinessStateV1::Ready
    );

    let verified = prepare_archive(&after, 0).unwrap();
    let selected = verified
        .selected
        .head
        .sealed_record()
        .persistence_projection_v1();
    assert!(
        verified.rotation_history.newest_event
            == Some((selected.revision_id(), predecessor_revision))
    );
}

#[test]
fn v2_genesis_cutover_migrates_to_v3_and_preserves_every_other_head() {
    let v1 = fixture();
    let v2 = append_registration(&v1, 0, 0, &[0, 1]).unwrap();
    assert_eq!(parse_archive(&v2).unwrap().version, MUTABLE_ARCHIVE_VERSION);
    let saved = v2.clone();
    let after = cutover(&v2, 3, &[0, 1], &[]);
    assert_eq!(v2, saved);
    assert_prefix_and_single_head_advance(&v2, &after, 3);
    let projected = checklist(&after, 3, &[0, 1], &[]);
    assert_eq!(
        projected.generation(),
        ArchiveRotationGenerationV1::Rotated0002
    );
    assert_eq!(projected.entries().len(), 2);
    assert!(
        projected
            .entries()
            .iter()
            .all(ArchiveRotationChecklistEntryV1::required_for_cutover)
    );
}

#[test]
fn two_cutovers_reach_terminal_and_a_third_returns_no_candidate() {
    let first = cutover(&fixture(), 0, &[], &[]);
    assert_no_synthetic_plaintext(&first);
    let second = cutover(&first, 0, &[], &[]);
    assert_no_synthetic_plaintext(&second);
    assert_prefix_and_single_head_advance(&first, &second, 0);
    let terminal = checklist(&second, 0, &[], &[]);
    assert_eq!(
        terminal.generation(),
        ArchiveRotationGenerationV1::Terminal0003
    );
    assert_eq!(
        terminal.readiness_state(),
        ArchiveRotationReadinessStateV1::Terminal
    );
    let saved = second.clone();
    assert_eq!(
        create_rotation_cutover_candidate(&second, 0, &[], &[], USER).err(),
        Some(ArchiveError::InvalidArchive)
    );
    assert_eq!(second, saved);
}

#[test]
fn connection_edit_between_cutovers_keeps_rotation_generation_and_exact_parent_chain() {
    let first = cutover(&fixture(), 0, &[], &[]);
    let first_prepared = prepare_archive(&first, 0).unwrap();
    assert_eq!(
        first_prepared.checklist.generation,
        ArchiveRotationGenerationV1::Rotated0002
    );
    assert_eq!(first_prepared.rotation_history.event_count, 1);
    let first_rotation_event = first_prepared.rotation_history.newest_event;
    let first_head = first_prepared.parsed.heads[0];
    let first_revision = match CredentialStorageAuthenticatorV1::new(&first_prepared.session)
        .authenticate_stored_credential_v1(first_prepared.parsed.records[first_head])
        .unwrap()
    {
        StoredCredentialAuthenticationOutcomeV1::Current(receipt) => receipt.revision_id(),
        StoredCredentialAuthenticationOutcomeV1::AuthenticatedFutureInner(_) => {
            panic!("generated current rotation unexpectedly became future data")
        }
    };
    drop(first_prepared);

    let edited = edit_connections(&first, 0, &[1, 2]).unwrap();
    assert_prefix_and_single_head_advance(&first, &edited, 0);
    let edited_prepared = prepare_archive(&edited, 0).unwrap();
    assert_eq!(
        edited_prepared.checklist.generation,
        ArchiveRotationGenerationV1::Rotated0002
    );
    assert_eq!(edited_prepared.rotation_history.event_count, 1);
    assert!(edited_prepared.rotation_history.newest_event == first_rotation_event);
    let edited_head = edited_prepared.parsed.heads[0];
    let (edited_revision, edited_parent) =
        match CredentialStorageAuthenticatorV1::new(&edited_prepared.session)
            .authenticate_stored_credential_v1(edited_prepared.parsed.records[edited_head])
            .unwrap()
        {
            StoredCredentialAuthenticationOutcomeV1::Current(receipt) => {
                (receipt.revision_id(), receipt.parent_revision_id())
            }
            StoredCredentialAuthenticationOutcomeV1::AuthenticatedFutureInner(_) => {
                panic!("generated current edit unexpectedly became future data")
            }
        };
    assert!(edited_parent == Some(first_revision));
    drop(edited_prepared);

    let terminal = cutover(&edited, 0, &[], &[]);
    assert_prefix_and_single_head_advance(&edited, &terminal, 0);
    assert_no_synthetic_plaintext(&terminal);
    let terminal_prepared = prepare_archive(&terminal, 0).unwrap();
    assert_eq!(
        terminal_prepared.checklist.generation,
        ArchiveRotationGenerationV1::Terminal0003
    );
    assert_eq!(terminal_prepared.rotation_history.event_count, 2);
    let terminal_head = terminal_prepared.parsed.heads[0];
    let (terminal_revision, terminal_parent) =
        match CredentialStorageAuthenticatorV1::new(&terminal_prepared.session)
            .authenticate_stored_credential_v1(terminal_prepared.parsed.records[terminal_head])
            .unwrap()
        {
            StoredCredentialAuthenticationOutcomeV1::Current(receipt) => {
                (receipt.revision_id(), receipt.parent_revision_id())
            }
            StoredCredentialAuthenticationOutcomeV1::AuthenticatedFutureInner(_) => {
                panic!("generated terminal rotation unexpectedly became future data")
            }
        };
    assert!(terminal_parent == Some(edited_revision));
    assert!(
        terminal_prepared.rotation_history.newest_event
            == Some((terminal_revision, edited_revision))
    );
}

#[test]
fn pending_required_selection_invalid_ids_duplicates_and_references_fail_closed() {
    let archive = fixture();
    let saved = archive.clone();
    assert_eq!(
        create_rotation_cutover_candidate(&archive, 1, &[], &[], USER).err(),
        Some(ArchiveError::InvalidArchive)
    );
    for result in [
        inspect_rotation_checklist(&archive, u32::MAX, &[], &[], USER),
        inspect_rotation_checklist(&archive, 0, &[3], &[], USER),
        inspect_rotation_checklist(&archive, 0, &[0], &[0], USER),
    ] {
        assert_eq!(result.err(), Some(ArchiveError::InvalidArchive));
    }
    assert_eq!(archive, saved);
}

#[test]
fn missing_branched_foreign_future_and_tampered_histories_fail_closed() {
    let source = fixture();
    let first = cutover(&source, 0, &[], &[]);
    let first_parsed = parse_archive(&first).unwrap();

    let missing = frame_v3(
        first_parsed.password_envelope,
        &[
            first_parsed.records[1],
            first_parsed.records[2],
            first_parsed.records[3],
        ],
        &[2, 0, 1],
    );
    assert_rejected_unchanged(&missing, ArchiveError::InvalidArchive);

    let sibling = cutover(&source, 0, &[], &[]);
    let sibling = parse_archive(&sibling).unwrap();
    let branched = frame_v3(
        first_parsed.password_envelope,
        &[
            first_parsed.records[0],
            first_parsed.records[1],
            first_parsed.records[2],
            first_parsed.records[3],
            sibling.records[3],
        ],
        &[4, 1, 2],
    );
    assert_rejected_unchanged(&branched, ArchiveError::InvalidArchive);

    let foreign = fixture();
    let foreign = parse_archive(&foreign).unwrap();
    let foreign_chain = frame_v3(
        first_parsed.password_envelope,
        &[
            foreign.records[0],
            first_parsed.records[1],
            first_parsed.records[2],
        ],
        &[0, 1, 2],
    );
    assert_rejected_unchanged(&foreign_chain, ArchiveError::AuthenticationFailed);

    let future = frame_v3(
        first_parsed.password_envelope,
        &[
            &[0x81, 0x01],
            first_parsed.records[1],
            first_parsed.records[2],
        ],
        &[0, 1, 2],
    );
    assert_rejected_unchanged(&future, ArchiveError::UpgradeRequired);

    let target = first_parsed.records[3];
    let offset = target.as_ptr() as usize - first.as_ptr() as usize;
    let mut tampered = first.clone();
    tampered[offset + target.len() - 1] ^= 1;
    assert_rejected_unchanged(&tampered, ArchiveError::AuthenticationFailed);
}

#[test]
fn counts_and_incomplete_events_are_rejected_before_mutation() {
    let mut too_many = cutover(&fixture(), 0, &[], &[]);
    too_many[16..20].copy_from_slice(&513_u32.to_le_bytes());
    assert_rejected_unchanged(&too_many, ArchiveError::LimitsExceeded);

    assert!(ensure_complete_history([SyntheticRotationRecordedCompletionV1::Complete]).is_ok());
    assert_eq!(
        ensure_complete_history([SyntheticRotationRecordedCompletionV1::Incomplete]),
        Err(ArchiveError::InvalidArchive)
    );
}
