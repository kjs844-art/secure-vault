use std::sync::OnceLock;

use vault_crypto::{
    KeyEpoch, OpaqueRecordId, PaddingBucketV0Alpha1, RecordContextV0Alpha1, RevisionId,
    SecretBytes, VaultSession, open_record_v0alpha1, seal_record_v0alpha1,
};
use vault_local_core::{
    SyntheticPasswordFixtureIdV1, SyntheticRotationStageRevocationV1,
    create_synthetic_successor_v1, seal_synthetic_password_fixture_v1,
};

use super::*;

const PENDING: SyntheticRotationStageRevocationV1 = SyntheticRotationStageRevocationV1::Pending;
const USER: SyntheticRotationStageRevocationV1 = SyntheticRotationStageRevocationV1::UserConfirmed;

struct Fixture {
    password: Vec<u8>,
    records: Vec<Vec<u8>>,
    successor: Vec<u8>,
}

fn fixture() -> &'static Fixture {
    static FIXTURE: OnceLock<Fixture> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let (created, mut records) = create_parts().unwrap();
        let password = seal_synthetic_password_fixture_v1(
            &created.session,
            SyntheticPasswordFixtureIdV1::WithIdentifier,
        )
        .unwrap();
        let successor = create_synthetic_successor_v1(&created.session, &password).unwrap();
        // Keep the unconnected API and the API with three consumers.
        records.remove(1);
        records.push(password.persistence_projection_v1().envelope().to_vec());
        Fixture {
            password: created.password_envelope,
            records,
            successor: successor.persistence_projection_v1().envelope().to_vec(),
        }
    })
}

fn session() -> VaultSession {
    unlock_vault_v0alpha1(&demo_password().unwrap(), &fixture().password).unwrap()
}

fn frame(version: u32, records: &[&[u8]], heads: &[usize]) -> Vec<u8> {
    match version {
        1 | 2 => encode_archive_version(version, &fixture().password, records).unwrap(),
        3 => history::encode(&fixture().password, records, heads).unwrap(),
        4 => staging::encode(&fixture().password, records, heads, &[]).unwrap(),
        _ => unreachable!(),
    }
}

fn genesis(version: u32) -> Vec<u8> {
    frame(
        version,
        &fixture()
            .records
            .iter()
            .map(Vec::as_slice)
            .collect::<Vec<_>>(),
        &[0, 1, 2],
    )
}

fn password_history(version: u32) -> Vec<u8> {
    let mut records = fixture()
        .records
        .iter()
        .map(Vec::as_slice)
        .collect::<Vec<_>>();
    records.push(&fixture().successor);
    frame(version, &records, &[0, 1, 3])
}

#[test]
fn mixed_genesis_reads_in_all_versions_without_changing_ciphertext() {
    let session = session();
    for version in 1..=4 {
        let bytes = genesis(version);
        let before = bytes.clone();
        let parsed = parse_archive(&bytes).unwrap();
        let catalog = project_archive(&session, &parsed).unwrap();
        assert_eq!(catalog.len(), 3);
        assert!(catalog.entry(0).unwrap().credential_type() == CatalogCredentialTypeV1::ApiKey);
        assert!(catalog.entry(2).unwrap().credential_type() == CatalogCredentialTypeV1::Password);
        assert_eq!(catalog.entry(2).unwrap().connection_count(), 0);
        assert_eq!(catalog.entry(2).unwrap().secret_field_count(), 2);
        assert_eq!(bytes, before);
    }
}

#[test]
fn password_successors_require_complete_v3_or_v4_history() {
    let session = session();
    for version in [3, 4] {
        let bytes = password_history(version);
        assert_eq!(
            project_archive(&session, &parse_archive(&bytes).unwrap())
                .unwrap()
                .len(),
            3
        );
        let missing = frame(
            version,
            &[
                &fixture().records[0],
                &fixture().records[1],
                &fixture().successor,
            ],
            &[0, 1, 2],
        );
        assert_eq!(
            project_archive(&session, &parse_archive(&missing).unwrap()).err(),
            Some(ArchiveError::InvalidArchive)
        );
    }
    for version in [1, 2] {
        let snapshot = frame(
            version,
            &[
                &fixture().records[0],
                &fixture().records[1],
                &fixture().successor,
            ],
            &[0, 1, 2],
        );
        assert_eq!(
            project_archive(&session, &parse_archive(&snapshot).unwrap()).err(),
            Some(ArchiveError::InvalidArchive)
        );
    }
}

#[test]
fn mixed_api_stage_reopen_finalize_and_append_preserve_password_history() {
    let original = password_history(3);
    let pending = create_rotation_stage_candidate(&original, 1, &[0], &[], PENDING).unwrap();
    assert_eq!(open_archive(&pending).unwrap().len(), 3);
    assert!(
        !inspect_rotation_stage(&pending, 1)
            .unwrap()
            .unwrap()
            .ready_for_cutover()
    );
    let ready = create_rotation_stage_candidate(&pending, 1, &[0], &[1], USER).unwrap();
    let finalized = create_rotation_cutover_from_stage_candidate(&ready, 1).unwrap();
    let appended = append_registration(&finalized, 0, 0, &[]).unwrap();
    let edited = edit_connections(&appended, 0, &[0]).unwrap();
    let before = parse_archive(&original).unwrap();
    for bytes in [&pending, &ready, &finalized, &appended, &edited] {
        let after = parse_archive(bytes).unwrap();
        assert_eq!(after.version, STAGING_ARCHIVE_VERSION);
        assert_eq!(&after.records[..before.records.len()], before.records);
        assert_eq!(after.heads[2], before.heads[2]);
        assert_eq!(after.password_envelope, before.password_envelope);
    }
    assert_eq!(open_archive(&edited).unwrap().len(), 4);
    assert!(inspect_rotation_stage(&finalized, 1).unwrap().is_none());
    // Canonical Password bytes must not contain the fixed sensitive plaintext.
    for secret in [
        b"DEMO_VALUE_ONLY_PASSWORD_FIXTURE_0001".as_slice(),
        b"DEMO_VALUE_ONLY_PASSWORD_IDENTIFIER_0001".as_slice(),
    ] {
        assert!(!edited.windows(secret.len()).any(|window| window == secret));
    }
}

#[test]
fn password_has_no_api_connection_or_rotation_capability() {
    let bytes = password_history(4);
    let saved = bytes.clone();
    assert_eq!(
        edit_connections(&bytes, 2, &[0]).err(),
        Some(ArchiveError::InvalidArchive)
    );
    assert_eq!(
        inspect_rotation_checklist(
            &bytes,
            2,
            &[],
            &[],
            vault_local_core::SyntheticVerificationEvidenceV1::UserConfirmed,
        )
        .err(),
        Some(ArchiveError::InvalidArchive)
    );
    assert_eq!(
        inspect_rotation_stage(&bytes, 2).err(),
        Some(ArchiveError::InvalidArchive)
    );
    assert_eq!(
        create_rotation_stage_candidate(&bytes, 2, &[], &[], PENDING).err(),
        Some(ArchiveError::InvalidArchive)
    );
    assert_eq!(
        create_rotation_cutover_from_stage_candidate(&bytes, 2).err(),
        Some(ArchiveError::InvalidArchive)
    );
    assert_eq!(bytes, saved);
}

// Test-only mutation of build-included fixture plaintext, sealed again with its
// original authenticated identity. This never becomes a public raw-input API.
fn mutate_authenticated_fixture(
    session: &VaultSession,
    envelope: &[u8],
    mutate: impl FnOnce(&mut [u8]),
) -> Vec<u8> {
    let RecordEnvelopeStorageDispositionV1::Current(inspection) =
        inspect_record_envelope_for_storage_v1(envelope).unwrap()
    else {
        panic!("current fixture")
    };
    let bucket = match inspection.padding_bucket_bytes() {
        1024 => PaddingBucketV0Alpha1::Bytes1024,
        4096 => PaddingBucketV0Alpha1::Bytes4096,
        16384 => PaddingBucketV0Alpha1::Bytes16384,
        61440 => PaddingBucketV0Alpha1::Bytes61440,
        _ => panic!("known fixture bucket"),
    };
    let context = RecordContextV0Alpha1::new(
        session.commitment(),
        OpaqueRecordId::from_bytes(*inspection.record_id()),
        RevisionId::from_bytes(*inspection.revision_id()),
        KeyEpoch::new(inspection.key_epoch()).unwrap(),
        bucket,
    );
    let plaintext = open_record_v0alpha1(session, &context, envelope).unwrap();
    let mut bytes = plaintext.expose_secret().to_vec();
    mutate(&mut bytes);
    seal_record_v0alpha1(session, &context, &SecretBytes::new(bytes).unwrap()).unwrap()
}

fn unknown_password_value(session: &VaultSession) -> Vec<u8> {
    mutate_authenticated_fixture(session, &fixture().records[2], |bytes| {
        let needle = b"DEMO_VALUE_ONLY_PASSWORD_FIXTURE_0001";
        let offset = bytes
            .windows(needle.len())
            .position(|window| window == needle)
            .unwrap();
        bytes[offset + needle.len() - 1] = b'9';
    })
}

// The v1 codec is a 30-field array; credential_type is field 12. Only the
// bounded uint/null/byte/text primitives preceding it are recognized here.
// Assert the fixture layout instead of guessing an offset or adding a decoder
// dependency. Any changed schema or unexpected fixture shape must fail the test.
fn fixture_credential_type_offset(bytes: &[u8]) -> usize {
    assert!(bytes.starts_with(&[0x98, 30, 1]));
    let mut offset = 2_usize;
    for _ in 0..12 {
        let initial = *bytes.get(offset).expect("known fixture field");
        offset += 1;
        if initial == 0xf6 {
            continue;
        }
        let major = initial >> 5;
        assert!(matches!(major, 0 | 2 | 3), "known fixture primitive");
        let argument = match initial & 0x1f {
            immediate @ 0..=23 => usize::from(immediate),
            24 => {
                let value = usize::from(*bytes.get(offset).expect("known fixture length"));
                offset += 1;
                value
            }
            25 => {
                let value = u16::from_be_bytes(
                    bytes
                        .get(offset..offset + 2)
                        .expect("known fixture length")
                        .try_into()
                        .unwrap(),
                );
                offset += 2;
                usize::from(value)
            }
            _ => panic!("fixture length is outside the bounded test parser"),
        };
        if major != 0 {
            offset = offset.checked_add(argument).unwrap();
            assert!(offset <= bytes.len(), "known fixture value length");
        }
    }
    assert!(*bytes.get(offset).expect("known credential type") <= 6);
    offset
}

fn fixture_with_credential_type(session: &VaultSession, envelope: &[u8], kind: u8) -> Vec<u8> {
    assert!(kind <= 6);
    mutate_authenticated_fixture(session, envelope, |bytes| {
        let offset = fixture_credential_type_offset(bytes);
        bytes[offset] = kind;
    })
}

fn assert_canonical_rejected_after_valid_topology(session: &VaultSession, bytes: &[u8]) {
    let before = bytes.to_vec();
    let parsed = parse_archive(bytes).unwrap();
    // These regressions must reach credential admission, not fail AEAD, model
    // decoding, identity checks, or the parent-before-child framing policy.
    history::validate(session, &parsed).unwrap();
    assert_eq!(
        project_archive(session, &parsed).err(),
        Some(ArchiveError::InvalidArchive)
    );
    assert_eq!(
        verify_candidate(session, bytes.to_vec()).err(),
        Some(ArchiveError::InvalidArchive)
    );
    assert!(bytes == before.as_slice());
}

#[test]
fn v3_type_switches_cannot_hide_password_ancestors_behind_api_heads() {
    let session = session();
    let api_successor = fixture_with_credential_type(&session, &fixture().successor, 1);
    let switched = frame(
        3,
        &[
            &fixture().records[0],
            &fixture().records[1],
            &fixture().records[2],
            &api_successor,
        ],
        &[0, 1, 3],
    );
    assert_canonical_rejected_after_valid_topology(&session, &switched);

    let predecessor = match CredentialStorageAuthenticatorV1::new(&session)
        .rehydrate_owned_stored_credential_v1(fixture().successor.clone())
        .unwrap()
    {
        OwnedRehydratedCredentialOutcomeV1::Current(record) => record,
        OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(_) => panic!("current fixture"),
    };
    let third = create_synthetic_successor_v1(&session, predecessor.sealed_record()).unwrap();
    let api_root = fixture_with_credential_type(&session, &fixture().records[2], 1);
    let api_head =
        fixture_with_credential_type(&session, third.persistence_projection_v1().envelope(), 1);
    let hidden_middle = frame(
        3,
        &[
            &fixture().records[0],
            &fixture().records[1],
            &api_root,
            &fixture().successor,
            &api_head,
        ],
        &[0, 1, 4],
    );
    assert_canonical_rejected_after_valid_topology(&session, &hidden_middle);
}

#[test]
fn structurally_known_unsupported_credential_kinds_fail_closed_in_every_archive_version() {
    let session = session();
    for (kind, expected) in [
        (2, CatalogCredentialTypeV1::OauthClient),
        (3, CatalogCredentialTypeV1::CloudAccessKey),
        (4, CatalogCredentialTypeV1::Token),
        (5, CatalogCredentialTypeV1::RecoveryCode),
        (6, CatalogCredentialTypeV1::Custom),
    ] {
        let unsupported = fixture_with_credential_type(&session, &fixture().records[2], kind);
        // Generic projection recognizes each enum. Only synthetic admission is
        // supposed to reject it; this is not an unknown-wire-enum regression.
        let decoded = project_records(&session, [unsupported.as_slice()]).unwrap();
        assert!(decoded.entry(0).unwrap().credential_type() == expected);
        for version in 1..=4 {
            let bytes = frame(
                version,
                &[&fixture().records[0], &fixture().records[1], &unsupported],
                &[0, 1, 2],
            );
            assert_canonical_rejected_after_valid_topology(&session, &bytes);
        }
    }
}

#[test]
fn unknown_sensitive_value_is_rejected_in_all_versions_and_in_non_head_ancestors() {
    let session = session();
    let invalid = unknown_password_value(&session);
    for version in 1..=4 {
        let mut records = vec![
            fixture().records[0].as_slice(),
            fixture().records[1].as_slice(),
            invalid.as_slice(),
        ];
        let mut heads = vec![0, 1, 2];
        if version >= HISTORY_ARCHIVE_VERSION {
            records.push(&fixture().successor);
            heads[2] = 3;
        }
        let bytes = frame(version, &records, &heads);
        let saved = bytes.clone();
        assert_eq!(
            project_archive(&session, &parse_archive(&bytes).unwrap()).err(),
            Some(ArchiveError::InvalidArchive)
        );
        assert_eq!(
            verify_candidate(&session, bytes.clone()).err(),
            Some(ArchiveError::InvalidArchive)
        );
        assert_eq!(bytes, saved);
    }
}

#[test]
fn password_cannot_be_a_stage_or_stage_base_and_inactive_stages_still_authenticate() {
    let session = session();
    let base = genesis(4);
    let parsed = parse_archive(&base).unwrap();
    let fake = staging::encode(
        parsed.password_envelope,
        &parsed.records,
        &parsed.heads,
        &[StagedEnvelope {
            base_index: 2,
            envelope: &fixture().successor,
        }],
    )
    .unwrap();
    assert_eq!(
        project_archive(&session, &parse_archive(&fake).unwrap()).err(),
        Some(ArchiveError::InvalidArchive)
    );
    let ready = create_rotation_stage_candidate(&base, 1, &[0], &[1], USER).unwrap();
    let finalized = create_rotation_cutover_from_stage_candidate(&ready, 1).unwrap();
    let parsed = parse_archive(&finalized).unwrap();
    let mut stages = parsed.stages.clone();
    stages[0].base_index = 2;
    let wrong_base = staging::encode(
        parsed.password_envelope,
        &parsed.records,
        &parsed.heads,
        &stages,
    )
    .unwrap();
    assert!(project_archive(&session, &parse_archive(&wrong_base).unwrap()).is_err());
    let mut corrupt = parsed.stages[0].envelope.to_vec();
    *corrupt.last_mut().unwrap() ^= 1;
    stages = parsed.stages.clone();
    stages[0].envelope = &corrupt;
    let inactive = staging::encode(
        parsed.password_envelope,
        &parsed.records,
        &parsed.heads,
        &stages,
    )
    .unwrap();
    assert_eq!(
        project_archive(&session, &parse_archive(&inactive).unwrap()).err(),
        Some(ArchiveError::AuthenticationFailed)
    );
}

#[test]
fn mixed_candidate_still_reserves_space_for_active_api_completion() {
    let session = session();
    let base = genesis(4);
    let parsed = parse_archive(&base).unwrap();
    project_archive(&session, &parsed).unwrap();
    assert_eq!(
        capacity::validate_candidate(&session, &parsed, MAX_ARCHIVE_BYTES),
        Ok(())
    );
    let pending = create_rotation_stage_candidate(&base, 1, &[], &[], PENDING).unwrap();
    let parsed = parse_archive(&pending).unwrap();
    project_archive(&session, &parsed).unwrap();
    assert_eq!(
        capacity::validate_candidate(&session, &parsed, pending.len()),
        Ok(())
    );
    // Arithmetic boundary only; this is not a browser quota claim.
    assert_eq!(
        capacity::validate_candidate(&session, &parsed, MAX_ARCHIVE_BYTES),
        Err(ArchiveError::LimitsExceeded)
    );
}
