use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use tempfile::TempDir;
use vault_crypto::{
    KeyEpoch, MasterPassword, OpaqueRecordId, PaddingBucketV0Alpha1,
    PasswordEnvelopeStorageDispositionV1, RecordContextV0Alpha1, RevisionId, SecretBytes,
    VaultCommitment, VaultSession, create_vault_v0alpha1, inspect_password_envelope_for_storage_v1,
    inspect_record_envelope_for_storage_v1, open_record_v0alpha1, seal_record_v0alpha1,
};
use vault_local_core::{
    CredentialStorageAuthenticatorV1, SyntheticCredentialFixtureId, seal_synthetic_fixture_v1,
};
use vault_local_store_sqlite::{
    ExistingVaultPreflightOutcomeV1, InitializeStoreOutcomeV1, PreflightAuthenticationOutcomeV1,
    StoreLocationPolicyV1, StoreLocationV1, TrustedLocalAppDataRootV1, initialize_v1,
    preflight_existing_v1,
};

struct Fixture {
    _directory: TempDir,
    location: StoreLocationV1,
    session: VaultSession,
    record_id: [u8; 16],
    revision_id: [u8; 32],
}

type RevisionSnapshot = ([u8; 16], [u8; 32], i64, i64, i64, i64, Vec<u8>);

#[derive(Eq, PartialEq)]
struct ExactSnapshot {
    main: Vec<u8>,
    wal: Option<Vec<u8>>,
    vault: Vec<(i64, i64, Vec<u8>)>,
    revisions: Vec<RevisionSnapshot>,
    heads: Vec<([u8; 16], [u8; 32])>,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let trusted_root = TrustedLocalAppDataRootV1::for_current_user().unwrap();
    let policy = StoreLocationPolicyV1::new(&trusted_root, directory.path()).unwrap();
    let location = policy.location("vault.sqlite3").unwrap();
    let password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_mutation_matrix.invalid".into()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) =
        inspect_password_envelope_for_storage_v1(&created.password_envelope).unwrap()
    else {
        panic!("fixture password envelope must be current");
    };
    let mut store = match initialize_v1(&location, inspection.bootstrap_projection()).unwrap() {
        InitializeStoreOutcomeV1::Created(store) => store,
        InitializeStoreOutcomeV1::AlreadyInitialized => panic!("temporary store already existed"),
    };
    let record = seal_synthetic_fixture_v1(
        &created.session,
        SyntheticCredentialFixtureId::SingleMcpConnection,
    )
    .unwrap();
    let projection = record.persistence_projection_v1();
    let record_id = *projection.record_id().as_bytes();
    let revision_id = *projection.revision_id().as_bytes();
    store.commit_candidate(projection).unwrap();
    drop(record);
    drop(store);
    Fixture {
        _directory: directory,
        location,
        session: created.session,
        record_id,
        revision_id,
    }
}

fn mutator(location: &StoreLocationV1) -> Connection {
    let connection = Connection::open(location.database_path()).unwrap();
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    connection
}

fn mutate_immutable_revisions(connection: &Connection, action: impl FnOnce(&Connection)) {
    let trigger_sql: Vec<String> = ["revisions_no_update", "revisions_no_delete"]
        .into_iter()
        .map(|name| {
            connection
                .query_row(
                    "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?1",
                    [name],
                    |row| row.get(0),
                )
                .unwrap()
        })
        .collect();
    connection
        .execute_batch("DROP TRIGGER revisions_no_update; DROP TRIGGER revisions_no_delete;")
        .unwrap();
    action(connection);
    for sql in trigger_sql {
        connection.execute_batch(&sql).unwrap();
    }
}

fn wal_path(database_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}-wal", database_path.display()))
}

fn snapshot(connection: &Connection, location: &StoreLocationV1) -> ExactSnapshot {
    let vault = connection
        .prepare("SELECT password_wire_version,password_suite_id,password_envelope FROM vault_state ORDER BY singleton")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let revisions = connection
        .prepare("SELECT record_id,revision_id,wire_version,suite_id,key_epoch,padding_bucket,envelope FROM revisions ORDER BY record_id,revision_id")
        .unwrap()
        .query_map([], |row| {
            let record: Vec<u8> = row.get(0)?;
            let revision: Vec<u8> = row.get(1)?;
            Ok((
                record.try_into().unwrap(),
                revision.try_into().unwrap(),
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let heads = connection
        .prepare("SELECT record_id,revision_id FROM heads ORDER BY record_id")
        .unwrap()
        .query_map([], |row| {
            let record: Vec<u8> = row.get(0)?;
            let revision: Vec<u8> = row.get(1)?;
            Ok((record.try_into().unwrap(), revision.try_into().unwrap()))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let wal = wal_path(location.database_path());
    ExactSnapshot {
        main: fs::read(location.database_path()).unwrap(),
        wal: wal.exists().then(|| fs::read(wal).unwrap()),
        vault,
        revisions,
        heads,
    }
}

fn assert_snapshot_unchanged(
    connection: &Connection,
    location: &StoreLocationV1,
    before: ExactSnapshot,
) {
    assert!(snapshot(connection, location) == before);
}

fn current_envelope(connection: &Connection, fixture: &Fixture) -> Vec<u8> {
    connection
        .query_row(
            "SELECT envelope FROM revisions WHERE record_id=?1 AND revision_id=?2",
            params![fixture.record_id.as_slice(), fixture.revision_id.as_slice()],
            |row| row.get(0),
        )
        .unwrap()
}

fn context_for(envelope: &[u8]) -> RecordContextV0Alpha1 {
    let vault_crypto::RecordEnvelopeStorageDispositionV1::Current(inspection) =
        inspect_record_envelope_for_storage_v1(envelope).unwrap()
    else {
        panic!("fixture record envelope must be current");
    };
    let padding = match inspection.padding_bucket_bytes() {
        1_024 => PaddingBucketV0Alpha1::Bytes1024,
        4_096 => PaddingBucketV0Alpha1::Bytes4096,
        16_384 => PaddingBucketV0Alpha1::Bytes16384,
        61_440 => PaddingBucketV0Alpha1::Bytes61440,
        _ => panic!("unexpected synthetic padding bucket"),
    };
    RecordContextV0Alpha1::new(
        VaultCommitment::from_bytes(*inspection.vault_commitment()),
        OpaqueRecordId::from_bytes(*inspection.record_id()),
        RevisionId::from_bytes(*inspection.revision_id()),
        KeyEpoch::new(inspection.key_epoch()).unwrap(),
        padding,
    )
}

fn reseal(session: &VaultSession, envelope: &[u8], plaintext: Vec<u8>) -> Vec<u8> {
    let context = context_for(envelope);
    seal_record_v0alpha1(session, &context, &SecretBytes::new(plaintext).unwrap()).unwrap()
}

fn byte_string_ranges(envelope: &[u8]) -> Vec<std::ops::Range<usize>> {
    fn argument(bytes: &[u8], cursor: &mut usize, expected_major: u8) -> usize {
        let initial = bytes[*cursor];
        *cursor += 1;
        assert_eq!(initial >> 5, expected_major);
        match initial & 0x1f {
            value @ 0..=23 => usize::from(value),
            24 => {
                let value = usize::from(bytes[*cursor]);
                *cursor += 1;
                value
            }
            25 => {
                let value = usize::from(u16::from_be_bytes([bytes[*cursor], bytes[*cursor + 1]]));
                *cursor += 2;
                value
            }
            other => panic!("unsupported synthetic CBOR argument {other}"),
        }
    }
    let mut cursor = 0;
    assert_eq!(argument(envelope, &mut cursor, 4), 12);
    for _ in 0..3 {
        argument(envelope, &mut cursor, 0);
    }
    let mut ranges = Vec::new();
    for field in 0..9 {
        if matches!(field, 3 | 4) {
            argument(envelope, &mut cursor, 0);
        } else {
            let length = argument(envelope, &mut cursor, 2);
            let start = cursor;
            cursor += length;
            ranges.push(start..cursor);
        }
    }
    assert_eq!(cursor, envelope.len());
    ranges
}

#[test]
fn future_outer_forms_and_higher_schema_preserve_exact_bytes() {
    for (wire, envelope) in [
        (1_i64, vec![0x81_u8, 0x01]),
        (2, vec![0x83_u8, 0x02, 0x40, 0x18, 0x2a]),
    ] {
        let fixture = fixture();
        let connection = mutator(&fixture.location);
        connection.execute("PRAGMA foreign_keys=OFF", []).unwrap();
        connection.execute("DELETE FROM heads", []).unwrap();
        mutate_immutable_revisions(&connection, |connection| {
            connection.execute("DELETE FROM revisions", []).unwrap();
            connection
                .execute(
                    "INSERT INTO revisions(record_id,revision_id,wire_version,suite_id,key_epoch,padding_bucket,envelope) VALUES(?1,?2,?3,0,1,1024,?4)",
                    params![[0x11_u8; 16].as_slice(), [0x22_u8; 32].as_slice(), wire, envelope],
                )
                .unwrap();
        });
        let before = snapshot(&connection, &fixture.location);
        assert!(matches!(
            preflight_existing_v1(&fixture.location).unwrap(),
            ExistingVaultPreflightOutcomeV1::CryptoUpgradeRequired
        ));
        assert_snapshot_unchanged(&connection, &fixture.location, before);
    }

    let fixture = fixture();
    let connection = mutator(&fixture.location);
    connection
        .pragma_update(None, "user_version", 2_i64)
        .unwrap();
    let before = snapshot(&connection, &fixture.location);
    assert!(matches!(
        preflight_existing_v1(&fixture.location).unwrap(),
        ExistingVaultPreflightOutcomeV1::SchemaUpgradeRequired
    ));
    assert_snapshot_unchanged(&connection, &fixture.location, before);
}

#[test]
fn authenticated_future_inner_is_a_global_crypto_upgrade_without_rewrite() {
    let fixture = fixture();
    let connection = mutator(&fixture.location);
    let envelope = current_envelope(&connection, &fixture);
    let future = reseal(&fixture.session, &envelope, vec![0x81, 0x02]);
    mutate_immutable_revisions(&connection, |connection| {
        connection
            .execute(
                "UPDATE revisions SET envelope=?1 WHERE record_id=?2 AND revision_id=?3",
                params![
                    future,
                    fixture.record_id.as_slice(),
                    fixture.revision_id.as_slice()
                ],
            )
            .unwrap();
    });
    let before = snapshot(&connection, &fixture.location);
    let preflight = match preflight_existing_v1(&fixture.location).unwrap() {
        ExistingVaultPreflightOutcomeV1::Current(preflight) => preflight,
        _ => panic!("future inner unexpectedly failed structural admission"),
    };
    let authenticator = CredentialStorageAuthenticatorV1::new(&fixture.session);
    assert!(matches!(
        preflight
            .authenticate_current_revisions(&authenticator)
            .unwrap(),
        PreflightAuthenticationOutcomeV1::CryptoUpgradeRequired
    ));
    assert_snapshot_unchanged(&connection, &fixture.location, before);
}

#[test]
fn schema_cache_and_foreign_key_corruption_latch_read_only_preservation() {
    for mutation in 0..4 {
        let fixture = fixture();
        let connection = mutator(&fixture.location);
        match mutation {
            0 => connection
                .execute_batch("ALTER TABLE vault_state ADD COLUMN unexpected BLOB;")
                .unwrap(),
            1 => connection
                .execute_batch(
                    "DROP TRIGGER conflicts_no_delete;
                     CREATE TRIGGER conflicts_no_delete BEFORE DELETE ON conflicts BEGIN SELECT RAISE(ABORT,'changed'); END;",
                )
                .unwrap(),
            2 => {
                connection.execute("PRAGMA foreign_keys=OFF", []).unwrap();
                let changed = [0x33_u8; 16];
                mutate_immutable_revisions(&connection, |connection| {
                    connection
                        .execute(
                            "UPDATE revisions SET record_id=?1 WHERE record_id=?2",
                            params![changed.as_slice(), fixture.record_id.as_slice()],
                        )
                        .unwrap();
                });
                connection
                    .execute(
                        "UPDATE heads SET record_id=?1 WHERE record_id=?2",
                        params![changed.as_slice(), fixture.record_id.as_slice()],
                    )
                    .unwrap();
            }
            _ => {
                connection.execute("PRAGMA foreign_keys=OFF", []).unwrap();
                connection
                    .execute(
                        "UPDATE heads SET revision_id=?1 WHERE record_id=?2",
                        params![[0x44_u8; 32].as_slice(), fixture.record_id.as_slice()],
                    )
                    .unwrap();
            }
        }
        let before = snapshot(&connection, &fixture.location);
        assert!(matches!(
            preflight_existing_v1(&fixture.location).unwrap(),
            ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation
        ));
        assert_snapshot_unchanged(&connection, &fixture.location, before);
    }
}

#[test]
fn nonce_wrapped_key_body_trailing_and_noncanonical_mutations_are_preserved() {
    for mutation in 0..5 {
        let fixture = fixture();
        let connection = mutator(&fixture.location);
        let mut envelope = current_envelope(&connection, &fixture);
        match mutation {
            0 => {
                let ranges = byte_string_ranges(&envelope);
                envelope[ranges[3].start] ^= 1;
            }
            1 => {
                let ranges = byte_string_ranges(&envelope);
                envelope[ranges[4].start] ^= 1;
            }
            2 => {
                let ranges = byte_string_ranges(&envelope);
                envelope[ranges[6].start] ^= 1;
            }
            3 => envelope.push(0),
            _ => {
                assert_eq!(&envelope[2..5], &[0x19, 0xa1, 0x01]);
                envelope.splice(2..5, [0x1a, 0x00, 0x00, 0xa1, 0x01]);
            }
        }
        mutate_immutable_revisions(&connection, |connection| {
            connection
                .execute(
                    "UPDATE revisions SET envelope=?1 WHERE record_id=?2 AND revision_id=?3",
                    params![
                        envelope,
                        fixture.record_id.as_slice(),
                        fixture.revision_id.as_slice()
                    ],
                )
                .unwrap();
        });
        let before = snapshot(&connection, &fixture.location);
        let structural = preflight_existing_v1(&fixture.location).unwrap();
        match mutation {
            0..=2 => {
                let ExistingVaultPreflightOutcomeV1::Current(preflight) = structural else {
                    panic!("authenticated corruption should remain structurally current");
                };
                let authenticator = CredentialStorageAuthenticatorV1::new(&fixture.session);
                assert!(matches!(
                    preflight
                        .authenticate_current_revisions(&authenticator)
                        .unwrap(),
                    PreflightAuthenticationOutcomeV1::ReadOnlyPreservation
                ));
            }
            _ => assert!(matches!(
                structural,
                ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation
            )),
        }
        assert_snapshot_unchanged(&connection, &fixture.location, before);
    }
}

#[test]
fn cross_vault_epoch_and_dangling_authenticated_parent_are_preserved() {
    for mutation in 0..3 {
        let fixture = fixture();
        let connection = mutator(&fixture.location);
        let envelope = current_envelope(&connection, &fixture);
        match mutation {
            0 => {
                let other_password = MasterPassword::from_utf8(
                    "DEMO_VALUE_ONLY_cross_vault_mutation.invalid".into(),
                )
                .unwrap();
                let other = create_vault_v0alpha1(&other_password).unwrap();
                let record = seal_synthetic_fixture_v1(
                    &other.session,
                    SyntheticCredentialFixtureId::SingleMcpConnection,
                )
                .unwrap();
                mutate_immutable_revisions(&connection, |connection| {
                    connection
                        .execute(
                            "UPDATE revisions SET envelope=?1 WHERE record_id=?2 AND revision_id=?3",
                            params![
                                record.persistence_projection_v1().envelope(),
                                fixture.record_id.as_slice(),
                                fixture.revision_id.as_slice()
                            ],
                        )
                        .unwrap();
                });
            }
            1 => {
                let mut changed = envelope;
                let epoch_offset = {
                    let ranges = byte_string_ranges(&changed);
                    ranges[2].end
                };
                assert_eq!(changed[epoch_offset], 0x01);
                changed[epoch_offset] = 0x02;
                mutate_immutable_revisions(&connection, |connection| {
                    connection
                        .execute(
                            "UPDATE revisions SET key_epoch=2,envelope=?1 WHERE record_id=?2 AND revision_id=?3",
                            params![changed, fixture.record_id.as_slice(), fixture.revision_id.as_slice()],
                        )
                        .unwrap();
                });
            }
            _ => {
                let context = context_for(&envelope);
                let plaintext =
                    open_record_v0alpha1(&fixture.session, &context, &envelope).unwrap();
                let mut changed = plaintext.expose_secret().to_vec();
                assert_eq!(&changed[..4], &[0x98, 30, 0x01, 0xf6]);
                changed.splice(
                    3..4,
                    std::iter::once(0x58)
                        .chain(std::iter::once(0x20))
                        .chain([0x55; 32]),
                );
                let changed = reseal(&fixture.session, &envelope, changed);
                mutate_immutable_revisions(&connection, |connection| {
                    connection
                        .execute(
                            "UPDATE revisions SET envelope=?1 WHERE record_id=?2 AND revision_id=?3",
                            params![
                                changed,
                                fixture.record_id.as_slice(),
                                fixture.revision_id.as_slice()
                            ],
                        )
                        .unwrap();
                });
            }
        }
        let before = snapshot(&connection, &fixture.location);
        let structural = preflight_existing_v1(&fixture.location).unwrap();
        if mutation == 0 {
            assert!(matches!(
                structural,
                ExistingVaultPreflightOutcomeV1::ReadOnlyPreservation
            ));
        } else {
            let ExistingVaultPreflightOutcomeV1::Current(preflight) = structural else {
                panic!("dangling encrypted parent should be structurally opaque");
            };
            let authenticator = CredentialStorageAuthenticatorV1::new(&fixture.session);
            assert!(matches!(
                preflight
                    .authenticate_current_revisions(&authenticator)
                    .unwrap(),
                PreflightAuthenticationOutcomeV1::ReadOnlyPreservation
            ));
        }
        assert_snapshot_unchanged(&connection, &fixture.location, before);
    }
}
