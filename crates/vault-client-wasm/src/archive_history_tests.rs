use std::sync::OnceLock;

use super::*;

fn fixture() -> &'static [u8] {
    static FIXTURE: OnceLock<Vec<u8>> = OnceLock::new();
    FIXTURE.get_or_init(|| create_archive().unwrap())
}

// Independent framing oracle, deliberately not the production encoder.
fn frame_v3(password: &[u8], revisions: &[&[u8]], heads: &[u32]) -> Vec<u8> {
    let mut output = b"KATLDEMO".to_vec();
    output.extend_from_slice(&3_u32.to_le_bytes());
    output.extend_from_slice(&(heads.len() as u32).to_le_bytes());
    output.extend_from_slice(&(revisions.len() as u32).to_le_bytes());
    for envelope in std::iter::once(password).chain(revisions.iter().copied()) {
        output.extend_from_slice(&(envelope.len() as u32).to_le_bytes());
        output.extend_from_slice(envelope);
    }
    for head in heads {
        output.extend_from_slice(&head.to_le_bytes());
    }
    output
}

#[test]
fn v3_genesis_heads_are_readable_without_mutating_legacy_bytes() {
    let before = fixture().to_vec();
    let parsed = parse_archive(&before).unwrap();
    let v3 = frame_v3(parsed.password_envelope, &parsed.records, &[0, 1, 2]);
    let catalog = open_archive(&v3).unwrap();
    assert_eq!(catalog.len(), 3);
    for (reference, expected) in [0, 1, 3].into_iter().enumerate() {
        assert_eq!(
            catalog.entry(reference as u32).unwrap().connection_count(),
            expected
        );
    }
    assert_eq!(before, fixture());
}

fn edited_fixture() -> &'static [u8] {
    static FIXTURE: OnceLock<Vec<u8>> = OnceLock::new();
    FIXTURE.get_or_init(|| edit_connections(fixture(), 0, &[0]).unwrap())
}

fn assert_rejected(bytes: &[u8], expected: ArchiveError) {
    let saved = bytes.to_vec();
    assert_eq!(open_archive(bytes).err(), Some(expected));
    assert_eq!(edit_connections(bytes, 0, &[]).err(), Some(expected));
    assert_eq!(append_registration(bytes, 0, 0, &[]).err(), Some(expected));
    assert!(bytes == saved, "rejection changed ciphertext");
}

fn assert_old_envelopes_preserved(before: &[u8], after: &[u8]) {
    let before = parse_archive(before).unwrap();
    let after = parse_archive(after).unwrap();
    assert_eq!(after.version, 3);
    assert!(before.password_envelope == after.password_envelope);
    assert_eq!(after.records.len(), before.records.len() + 1);
    assert!(
        before
            .records
            .iter()
            .zip(&after.records)
            .all(|(old, new)| old == new)
    );
}

#[test]
fn successive_edits_keep_all_envelopes_and_only_replace_selected_head() {
    let mut current = fixture().to_vec();
    for connections in [&[0][..], &[2, 0, 1][..], &[][..]] {
        let before = current.clone();
        let next = edit_connections(&current, 0, connections).unwrap();
        assert_old_envelopes_preserved(&current, &next);
        let old = parse_archive(&current).unwrap();
        let new = parse_archive(&next).unwrap();
        assert_eq!(new.heads, [old.records.len(), 1, 2]);
        let catalog = open_archive(&next).unwrap();
        assert_eq!(catalog.len(), 3);
        assert_eq!(
            catalog.entry(0).unwrap().connection_count(),
            connections.len()
        );
        assert_eq!(catalog.entry(1).unwrap().connection_count(), 1);
        assert_eq!(catalog.entry(2).unwrap().connection_count(), 3);
        assert_eq!(catalog.entry(2).unwrap().secret_field_count(), 2);
        assert!(current == before);
        current = next;
    }
    for plaintext in [
        DEMO_PASSWORD.as_bytes(),
        b"DEMO_VALUE_ONLY_API_KEY_0001",
        b"Example AI Workshop",
    ] {
        assert!(
            !current
                .windows(plaintext.len())
                .any(|window| window == plaintext)
        );
    }
}

#[test]
fn both_registered_profiles_migrate_and_append_preserves_existing_history() {
    let first = append_registration(fixture(), 0, 0, &[0]).unwrap();
    let second = append_registration(&first, 1, 0, &[1]).unwrap();
    let edited_first = edit_connections(&second, 3, &[2, 1, 0]).unwrap();
    let edited_second = edit_connections(&edited_first, 4, &[]).unwrap();
    assert_old_envelopes_preserved(&second, &edited_first);
    assert_old_envelopes_preserved(&edited_first, &edited_second);
    let appended = append_registration(&edited_second, 1, 0, &[0]).unwrap();
    assert_old_envelopes_preserved(&edited_second, &appended);
    let parsed = parse_archive(&appended).unwrap();
    assert_eq!(parsed.heads, [0, 1, 2, 5, 6, 7]);
    let catalog = open_archive(&appended).unwrap();
    assert_eq!(catalog.len(), 6);
    assert_eq!(catalog.entry(3).unwrap().connection_count(), 3);
    assert_eq!(catalog.entry(4).unwrap().connection_count(), 0);
    assert_eq!(catalog.entry(5).unwrap().connection_count(), 1);
    assert!(catalog.entry(4).unwrap().provider_name() == "Example Cloud Lab");
}

#[test]
fn reference_follows_exact_explicit_head_order_not_revision_array_order() {
    let parsed = parse_archive(edited_fixture()).unwrap();
    let reordered = frame_v3(parsed.password_envelope, &parsed.records, &[2, 3, 1]);
    let catalog = open_archive(&reordered).unwrap();
    assert_eq!(catalog.entry(0).unwrap().secret_field_count(), 2);
    let edited = edit_connections(&reordered, 0, &[]).unwrap();
    assert_old_envelopes_preserved(&reordered, &edited);
    let catalog = open_archive(&edited).unwrap();
    assert_eq!(catalog.entry(0).unwrap().connection_count(), 0);
    assert_eq!(catalog.entry(0).unwrap().secret_field_count(), 2);
    assert_eq!(catalog.entry(1).unwrap().connection_count(), 1);
    assert_eq!(parse_archive(&edited).unwrap().heads, [4, 3, 1]);
}

#[test]
fn non_head_corruption_and_future_formats_never_return_partial_catalogs() {
    let parsed = parse_archive(edited_fixture()).unwrap();
    let mut damaged = parsed.records[0].to_vec();
    *damaged.last_mut().unwrap() ^= 1;
    let mut revisions = parsed.records.clone();
    revisions[0] = &damaged;
    assert_rejected(
        &frame_v3(parsed.password_envelope, &revisions, &[3, 1, 2]),
        ArchiveError::AuthenticationFailed,
    );
    revisions[0] = &[0x81, 0x01];
    assert_rejected(
        &frame_v3(parsed.password_envelope, &revisions, &[3, 1, 2]),
        ArchiveError::UpgradeRequired,
    );
    revisions[0] = &[0];
    assert_rejected(
        &frame_v3(parsed.password_envelope, &revisions, &[3, 1, 2]),
        ArchiveError::InvalidArchive,
    );
}

#[test]
fn missing_forward_duplicate_and_branched_revisions_are_rejected() {
    let parsed = parse_archive(edited_fixture()).unwrap();
    let r = &parsed.records;
    for revisions in [
        vec![r[1], r[2], r[3]],       // Missing original parent.
        vec![r[1], r[2], r[3], r[0]], // Parent occurs after child.
        vec![r[0], r[1], r[2], r[0]], // Duplicate authenticated revision.
    ] {
        assert_rejected(
            &frame_v3(parsed.password_envelope, &revisions, &[0, 1, 2]),
            ArchiveError::InvalidArchive,
        );
    }
    // Independently generated successors of the same original parent must not
    // be mistaken for one linear chain even if the head points to the last one.
    let other = edit_connections(fixture(), 0, &[1]).unwrap();
    let other = parse_archive(&other).unwrap();
    let mut branch = r.clone();
    branch.push(other.records[3]);
    assert_rejected(
        &frame_v3(parsed.password_envelope, &branch, &[4, 1, 2]),
        ArchiveError::InvalidArchive,
    );
}

#[test]
fn heads_must_cover_each_record_once_and_point_to_its_final_leaf() {
    let parsed = parse_archive(edited_fixture()).unwrap();
    for heads in [[0, 1, 2], [3, 3, 2], [3, 1, 4], [0, 3, 2]] {
        assert_rejected(
            &frame_v3(parsed.password_envelope, &parsed.records, &heads),
            ArchiveError::InvalidArchive,
        );
    }
    let appended = append_registration(edited_fixture(), 0, 0, &[]).unwrap();
    let parsed = parse_archive(&appended).unwrap();
    // A fourth record cannot be silently omitted from the head table.
    assert_rejected(
        &frame_v3(parsed.password_envelope, &parsed.records, &[3, 1, 2]),
        ArchiveError::InvalidArchive,
    );
}

#[test]
fn legacy_successor_still_opens_but_cannot_fabricate_missing_history_on_edit() {
    let parsed = parse_archive(edited_fixture()).unwrap();
    let records = [parsed.records[3], parsed.records[1], parsed.records[2]];
    for version in [1, 2] {
        let legacy = encode_archive_version(version, parsed.password_envelope, &records).unwrap();
        let saved = legacy.clone();
        assert_eq!(open_archive(&legacy).unwrap().len(), 3);
        assert_eq!(
            edit_connections(&legacy, 0, &[]).err(),
            Some(ArchiveError::InvalidArchive)
        );
        assert!(legacy == saved);
    }
}

#[test]
fn invalid_edit_selections_leave_original_ciphertext_unchanged() {
    let saved = fixture().to_vec();
    for (reference, connections, expected) in [
        (3, &[][..], ArchiveError::InvalidArchive),
        (u32::MAX, &[][..], ArchiveError::InvalidArchive),
        (0, &[3][..], ArchiveError::InvalidArchive),
        (0, &[0, 0][..], ArchiveError::InvalidArchive),
        (0, &[0, 1, 2, 0][..], ArchiveError::LimitsExceeded),
    ] {
        assert_eq!(
            edit_connections(fixture(), reference, connections).err(),
            Some(expected)
        );
        assert!(fixture() == saved);
    }
}

#[test]
fn v3_count_length_and_trailing_constraints_are_checked_without_unlocking() {
    for (offset, value, expected) in [
        (12, 2, ArchiveError::InvalidArchive),
        (12, 129, ArchiveError::LimitsExceeded),
        (16, 2, ArchiveError::InvalidArchive),
        (16, 513, ArchiveError::LimitsExceeded),
        (16, u32::MAX, ArchiveError::LimitsExceeded),
        (20, 0, ArchiveError::InvalidArchive),
        (20, 65_537, ArchiveError::LimitsExceeded),
    ] {
        let mut bytes = edited_fixture().to_vec();
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        assert_eq!(parse_archive(&bytes).err(), Some(expected));
    }
    for end in [16, 19, 20, 23, edited_fixture().len() - 1] {
        assert_eq!(
            parse_archive(&edited_fixture()[..end]).err(),
            Some(ArchiveError::InvalidArchive)
        );
    }
    let mut trailing = edited_fixture().to_vec();
    trailing.push(0);
    assert_eq!(
        parse_archive(&trailing).err(),
        Some(ArchiveError::InvalidArchive)
    );
    let tiny = [1_u8];
    let revisions = vec![tiny.as_slice(); 512];
    let at_limit = history::encode(&tiny, &revisions, &[509, 510, 511]).unwrap();
    assert_eq!(parse_archive(&at_limit).unwrap().records.len(), 512);
    assert_eq!(
        edit_connections(&at_limit, 0, &[]).err(),
        Some(ArchiveError::InvalidArchive)
    );
    let mut too_many = revisions;
    too_many.push(&tiny);
    assert_eq!(
        history::encode(&tiny, &too_many, &[510, 511, 512]).err(),
        Some(ArchiveError::LimitsExceeded)
    );
    let large = vec![0_u8; MAX_ENVELOPE_BYTES];
    assert_eq!(
        history::encode(&tiny, &[large.as_slice(); 8], &[0, 1, 2]).err(),
        Some(ArchiveError::LimitsExceeded)
    );
}

#[test]
fn output_candidate_is_fully_validated_before_return_even_for_generated_collisions() {
    let parsed = parse_archive(edited_fixture()).unwrap();
    let session =
        unlock_vault_v0alpha1(&demo_password().unwrap(), parsed.password_envelope).unwrap();
    let mut revisions = parsed.records.clone();
    revisions.push(revisions[3]);
    let duplicate = frame_v3(parsed.password_envelope, &revisions, &[4, 1, 2]);
    assert_eq!(
        verify_candidate(&session, duplicate).err(),
        Some(ArchiveError::InvalidArchive)
    );
    let valid = edited_fixture().to_vec();
    assert!(verify_candidate(&session, valid.clone()).unwrap() == valid);
}
