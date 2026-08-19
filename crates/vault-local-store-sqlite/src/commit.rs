use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use vault_crypto::{
    PasswordEnvelopeStorageDispositionV1, RecordEnvelopeStorageDispositionV1,
    inspect_password_envelope_for_storage_v1, inspect_record_envelope_for_storage_v1,
};
use vault_local_core::{CredentialCommitPersistenceProjectionV1, StoredPaddingBucketV0Alpha1};

use crate::{StorageError, StorageErrorCode, SyntheticWritableStoreV1};

#[cfg(test)]
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitOutcomeV1 {
    Committed,
    AlreadyCommitted,
    ConflictPreserved,
}

struct PreparedCandidateV1 {
    vault_commitment: [u8; 32],
    record_id: [u8; 16],
    revision_id: [u8; 32],
    expected_revision_id: Option<[u8; 32]>,
    wire_version: u32,
    suite_id: u32,
    key_epoch: u32,
    padding_bucket: i64,
    envelope: Vec<u8>,
}

struct StoredRevisionV1 {
    wire_version: i64,
    suite_id: i64,
    key_epoch: i64,
    padding_bucket: i64,
    envelope: Vec<u8>,
}

enum CommitFailureV1 {
    NonLatching(StorageErrorCode),
    Invariant,
}

struct CommitTransactionResultV1 {
    outcome: CommitOutcomeV1,
    #[cfg(test)]
    created_revision: bool,
}

impl CommitTransactionResultV1 {
    fn new(outcome: CommitOutcomeV1, _created_revision: bool) -> Self {
        Self {
            outcome,
            #[cfg(test)]
            created_revision: _created_revision,
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum TransactionCrashPointV1 {
    InitialBefore,
    InitialAfter,
    ConflictBefore,
    ConflictAfter,
}

#[cfg(test)]
type TransactionObserverV1 = fn(TransactionCrashPointV1);

#[cfg(test)]
static TRANSACTION_OBSERVER_V1: OnceLock<TransactionObserverV1> = OnceLock::new();

#[cfg(test)]
pub(crate) fn install_transaction_observer_for_test(observer: TransactionObserverV1) {
    assert!(
        TRANSACTION_OBSERVER_V1.set(observer).is_ok(),
        "transaction observer was already installed"
    );
}

impl PreparedCandidateV1 {
    fn from_projection(projection: CredentialCommitPersistenceProjectionV1<'_>) -> Self {
        Self {
            vault_commitment: *projection.vault_commitment(),
            record_id: *projection.record_id().as_bytes(),
            revision_id: *projection.revision_id().as_bytes(),
            expected_revision_id: projection
                .expected_revision_id()
                .map(|revision| *revision.as_bytes()),
            wire_version: projection.wire_version(),
            suite_id: projection.suite_id(),
            key_epoch: projection.key_epoch(),
            padding_bucket: padding_bucket_bytes(projection.padding_bucket()),
            envelope: projection.envelope().to_vec(),
        }
    }
}

impl SyntheticWritableStoreV1 {
    pub fn commit_candidate(
        &mut self,
        projection: CredentialCommitPersistenceProjectionV1<'_>,
    ) -> Result<CommitOutcomeV1, StorageError> {
        let candidate = PreparedCandidateV1::from_projection(projection);
        self.commit_prepared_candidate(&candidate)
    }

    fn commit_prepared_candidate(
        &mut self,
        candidate: &PreparedCandidateV1,
    ) -> Result<CommitOutcomeV1, StorageError> {
        if self.preservation_latched {
            return Err(StorageError::new(StorageErrorCode::InvariantViolation));
        }
        #[cfg(test)]
        {
            self.sql_access_count += 1;
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(transaction_start_error)?;
        match commit_in_transaction(&transaction, candidate) {
            Ok(result) => {
                #[cfg(test)]
                observe_transaction_boundary(candidate, &result, true);
                if transaction.commit().is_err() {
                    self.preservation_latched = true;
                    return Err(StorageError::new(StorageErrorCode::Io));
                }
                #[cfg(test)]
                observe_transaction_boundary(candidate, &result, false);
                Ok(result.outcome)
            }
            Err(CommitFailureV1::NonLatching(code)) => {
                drop(transaction);
                Err(StorageError::new(code))
            }
            Err(CommitFailureV1::Invariant) => {
                drop(transaction);
                self.preservation_latched = true;
                Err(StorageError::new(StorageErrorCode::InvariantViolation))
            }
        }
    }
}

fn commit_in_transaction(
    transaction: &Transaction<'_>,
    candidate: &PreparedCandidateV1,
) -> Result<CommitTransactionResultV1, CommitFailureV1> {
    validate_candidate_metadata(candidate)?;
    if candidate.vault_commitment != read_current_vault_commitment(transaction)? {
        return Err(CommitFailureV1::NonLatching(
            StorageErrorCode::WrongVaultCandidate,
        ));
    }

    if let Some(stored) = read_same_primary_key(transaction, candidate)? {
        if stored.wire_version != i64::from(candidate.wire_version)
            || stored.suite_id != i64::from(candidate.suite_id)
            || stored.key_epoch != i64::from(candidate.key_epoch)
            || stored.padding_bucket != candidate.padding_bucket
            || stored.envelope != candidate.envelope
        {
            return Err(CommitFailureV1::Invariant);
        }
        if let Some(stored_expected) = read_existing_conflict_expected(transaction, candidate)? {
            if stored_expected.as_deref()
                != candidate
                    .expected_revision_id
                    .as_ref()
                    .map(<[u8; 32]>::as_slice)
            {
                return Err(CommitFailureV1::Invariant);
            }
            return Ok(CommitTransactionResultV1::new(
                CommitOutcomeV1::ConflictPreserved,
                false,
            ));
        }
        return Ok(CommitTransactionResultV1::new(
            CommitOutcomeV1::AlreadyCommitted,
            false,
        ));
    }

    let observed_head = read_head(transaction, &candidate.record_id)?;
    if let Some(expected) = candidate.expected_revision_id.as_ref()
        && (!revision_exists(transaction, &candidate.record_id, expected)?
            || observed_head.is_none())
    {
        return Err(CommitFailureV1::NonLatching(StorageErrorCode::MissingBase));
    }

    insert_revision(transaction, candidate)?;
    match (candidate.expected_revision_id.as_ref(), observed_head) {
        (None, None) => {
            let changed = transaction
                .execute(
                    "INSERT INTO heads(record_id,revision_id) VALUES(?1,?2)",
                    params![
                        candidate.record_id.as_slice(),
                        candidate.revision_id.as_slice()
                    ],
                )
                .map_err(|_| CommitFailureV1::Invariant)?;
            require_exactly_one(changed)?;
            Ok(CommitTransactionResultV1::new(
                CommitOutcomeV1::Committed,
                true,
            ))
        }
        (None, Some(observed)) => {
            insert_conflict(transaction, candidate, None, &observed)?;
            Ok(CommitTransactionResultV1::new(
                CommitOutcomeV1::ConflictPreserved,
                true,
            ))
        }
        (Some(expected), Some(_)) => {
            let changed = transaction
                .execute(
                    "UPDATE heads SET revision_id=?1 WHERE record_id=?2 AND revision_id=?3",
                    params![
                        candidate.revision_id.as_slice(),
                        candidate.record_id.as_slice(),
                        expected.as_slice(),
                    ],
                )
                .map_err(|_| CommitFailureV1::Invariant)?;
            match changed {
                1 => Ok(CommitTransactionResultV1::new(
                    CommitOutcomeV1::Committed,
                    true,
                )),
                0 => {
                    let observed = read_head(transaction, &candidate.record_id)?
                        .ok_or(CommitFailureV1::Invariant)?;
                    insert_conflict(transaction, candidate, Some(expected), &observed)?;
                    Ok(CommitTransactionResultV1::new(
                        CommitOutcomeV1::ConflictPreserved,
                        true,
                    ))
                }
                _ => Err(CommitFailureV1::Invariant),
            }
        }
        (Some(_), None) => unreachable!("head presence was checked before insert"),
    }
}

#[cfg(test)]
fn observe_transaction_boundary(
    candidate: &PreparedCandidateV1,
    result: &CommitTransactionResultV1,
    before_commit: bool,
) {
    if !result.created_revision {
        return;
    }
    let point = match (
        candidate.expected_revision_id.is_none(),
        result.outcome,
        before_commit,
    ) {
        (true, CommitOutcomeV1::Committed, true) => TransactionCrashPointV1::InitialBefore,
        (true, CommitOutcomeV1::Committed, false) => TransactionCrashPointV1::InitialAfter,
        (false, CommitOutcomeV1::ConflictPreserved, true) => {
            TransactionCrashPointV1::ConflictBefore
        }
        (false, CommitOutcomeV1::ConflictPreserved, false) => {
            TransactionCrashPointV1::ConflictAfter
        }
        _ => return,
    };
    if let Some(observer) = TRANSACTION_OBSERVER_V1.get() {
        observer(point);
    }
}

fn validate_candidate_metadata(candidate: &PreparedCandidateV1) -> Result<(), CommitFailureV1> {
    let disposition = inspect_record_envelope_for_storage_v1(&candidate.envelope)
        .map_err(|_| CommitFailureV1::Invariant)?;
    let RecordEnvelopeStorageDispositionV1::Current(inspection) = disposition else {
        return Err(CommitFailureV1::Invariant);
    };
    if inspection.vault_commitment() != &candidate.vault_commitment
        || inspection.record_id() != &candidate.record_id
        || inspection.revision_id() != &candidate.revision_id
        || inspection.wire_version() != candidate.wire_version
        || inspection.suite_id() != candidate.suite_id
        || inspection.key_epoch() != candidate.key_epoch
        || i64::try_from(inspection.padding_bucket_bytes()).ok() != Some(candidate.padding_bucket)
        || inspection.envelope() != candidate.envelope.as_slice()
    {
        return Err(CommitFailureV1::Invariant);
    }
    Ok(())
}

fn read_current_vault_commitment(
    transaction: &Transaction<'_>,
) -> Result<[u8; 32], CommitFailureV1> {
    let stored = transaction
        .query_row(
            "SELECT password_wire_version,password_suite_id,length(password_envelope),password_envelope \
             FROM vault_state WHERE singleton=1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| CommitFailureV1::Invariant)?
        .ok_or(CommitFailureV1::Invariant)?;
    if !(1..=65_536).contains(&stored.2) || i64::try_from(stored.3.len()).ok() != Some(stored.2) {
        return Err(CommitFailureV1::Invariant);
    }
    let disposition = inspect_password_envelope_for_storage_v1(&stored.3)
        .map_err(|_| CommitFailureV1::Invariant)?;
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) = disposition else {
        return Err(CommitFailureV1::Invariant);
    };
    if i64::from(inspection.wire_version()) != stored.0
        || i64::from(inspection.suite_id()) != stored.1
        || inspection.envelope() != stored.3.as_slice()
    {
        return Err(CommitFailureV1::Invariant);
    }
    Ok(*inspection.vault_commitment())
}

fn read_same_primary_key(
    transaction: &Transaction<'_>,
    candidate: &PreparedCandidateV1,
) -> Result<Option<StoredRevisionV1>, CommitFailureV1> {
    transaction
        .query_row(
            "SELECT wire_version,suite_id,key_epoch,padding_bucket,envelope \
             FROM revisions WHERE record_id=?1 AND revision_id=?2",
            params![
                candidate.record_id.as_slice(),
                candidate.revision_id.as_slice()
            ],
            |row| {
                Ok(StoredRevisionV1 {
                    wire_version: row.get(0)?,
                    suite_id: row.get(1)?,
                    key_epoch: row.get(2)?,
                    padding_bucket: row.get(3)?,
                    envelope: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|_| CommitFailureV1::Invariant)
}

fn read_existing_conflict_expected(
    transaction: &Transaction<'_>,
    candidate: &PreparedCandidateV1,
) -> Result<Option<Option<Vec<u8>>>, CommitFailureV1> {
    transaction
        .query_row(
            "SELECT expected_head_revision_id FROM conflicts \
             WHERE record_id=?1 AND candidate_revision_id=?2",
            params![
                candidate.record_id.as_slice(),
                candidate.revision_id.as_slice()
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommitFailureV1::Invariant)
}

fn read_head(
    transaction: &Transaction<'_>,
    record_id: &[u8; 16],
) -> Result<Option<[u8; 32]>, CommitFailureV1> {
    let bytes: Option<Vec<u8>> = transaction
        .query_row(
            "SELECT revision_id FROM heads WHERE record_id=?1",
            [record_id.as_slice()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommitFailureV1::Invariant)?;
    bytes
        .map(|bytes| bytes.try_into().map_err(|_| CommitFailureV1::Invariant))
        .transpose()
}

fn revision_exists(
    transaction: &Transaction<'_>,
    record_id: &[u8; 16],
    revision_id: &[u8; 32],
) -> Result<bool, CommitFailureV1> {
    transaction
        .query_row(
            "SELECT 1 FROM revisions WHERE record_id=?1 AND revision_id=?2",
            params![record_id.as_slice(), revision_id.as_slice()],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(|_| CommitFailureV1::Invariant)
}

fn insert_revision(
    transaction: &Transaction<'_>,
    candidate: &PreparedCandidateV1,
) -> Result<(), CommitFailureV1> {
    let changed = transaction
        .execute(
            "INSERT INTO revisions(\
                record_id,revision_id,wire_version,suite_id,key_epoch,padding_bucket,envelope\
             ) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                candidate.record_id.as_slice(),
                candidate.revision_id.as_slice(),
                i64::from(candidate.wire_version),
                i64::from(candidate.suite_id),
                i64::from(candidate.key_epoch),
                candidate.padding_bucket,
                candidate.envelope.as_slice(),
            ],
        )
        .map_err(|_| CommitFailureV1::Invariant)?;
    require_exactly_one(changed)
}

fn insert_conflict(
    transaction: &Transaction<'_>,
    candidate: &PreparedCandidateV1,
    expected: Option<&[u8; 32]>,
    observed: &[u8; 32],
) -> Result<(), CommitFailureV1> {
    let changed = transaction
        .execute(
            "INSERT INTO conflicts(\
                record_id,candidate_revision_id,expected_head_revision_id,observed_head_revision_id\
             ) VALUES(?1,?2,?3,?4)",
            params![
                candidate.record_id.as_slice(),
                candidate.revision_id.as_slice(),
                expected.map(<[u8; 32]>::as_slice),
                observed.as_slice(),
            ],
        )
        .map_err(|_| CommitFailureV1::Invariant)?;
    require_exactly_one(changed)
}

fn require_exactly_one(changed: usize) -> Result<(), CommitFailureV1> {
    if changed == 1 {
        Ok(())
    } else {
        Err(CommitFailureV1::Invariant)
    }
}

const fn padding_bucket_bytes(bucket: StoredPaddingBucketV0Alpha1) -> i64 {
    match bucket {
        StoredPaddingBucketV0Alpha1::Bytes1024 => 1_024,
        StoredPaddingBucketV0Alpha1::Bytes4096 => 4_096,
        StoredPaddingBucketV0Alpha1::Bytes16384 => 16_384,
        StoredPaddingBucketV0Alpha1::Bytes61440 => 61_440,
    }
}

fn transaction_start_error(error: rusqlite::Error) -> StorageError {
    let code = match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            StorageErrorCode::Busy
        }
        _ => StorageErrorCode::Io,
    };
    StorageError::new(code)
}

#[cfg(test)]
type RevisionSnapshotRowV1 = (Vec<u8>, Vec<u8>, i64, i64, i64, i64, Vec<u8>);

#[cfg(test)]
type ConflictSnapshotRowV1 = (Vec<u8>, Vec<u8>, Option<Vec<u8>>, Vec<u8>);

#[cfg(test)]
#[derive(Debug, Eq, PartialEq)]
struct LogicalSnapshotV1 {
    revisions: Vec<RevisionSnapshotRowV1>,
    heads: Vec<(Vec<u8>, Vec<u8>)>,
    conflicts: Vec<ConflictSnapshotRowV1>,
}

#[cfg(test)]
struct TestDbFixtureV1 {
    _directory: tempfile::TempDir,
    created: vault_crypto::CreatedVaultV0Alpha1,
    store: SyntheticWritableStoreV1,
}

#[cfg(test)]
impl PreparedCandidateV1 {
    fn clone_for_test(&self) -> Self {
        Self {
            vault_commitment: self.vault_commitment,
            record_id: self.record_id,
            revision_id: self.revision_id,
            expected_revision_id: self.expected_revision_id,
            wire_version: self.wire_version,
            suite_id: self.suite_id,
            key_epoch: self.key_epoch,
            padding_bucket: self.padding_bucket,
            envelope: self.envelope.clone(),
        }
    }

    fn flip_authenticated_body_byte_for_test(&mut self) {
        *self.envelope.last_mut().unwrap() ^= 1;
    }

    fn change_cached_epoch_for_test(&mut self) {
        self.key_epoch = self.key_epoch.saturating_add(1);
    }

    fn change_expected_to_nonexistent_for_test(&mut self) {
        self.expected_revision_id = Some([0xa5; 32]);
    }

    fn clear_expected_for_test(&mut self) {
        self.expected_revision_id = None;
    }
}

#[cfg(test)]
impl TestDbFixtureV1 {
    fn new() -> Self {
        use vault_crypto::{
            MasterPassword, PasswordEnvelopeStorageDispositionV1, create_vault_v0alpha1,
            inspect_password_envelope_for_storage_v1,
        };

        let directory = tempfile::tempdir().unwrap();
        let trusted_root = crate::TrustedLocalAppDataRootV1::for_current_user().unwrap();
        let policy = crate::StoreLocationPolicyV1::new(&trusted_root, directory.path()).unwrap();
        let location = policy.location("vault.sqlite3").unwrap();
        let password =
            MasterPassword::from_utf8("DEMO_VALUE_ONLY_private_commit_fixture".to_owned()).unwrap();
        let created = create_vault_v0alpha1(&password).unwrap();
        let disposition =
            inspect_password_envelope_for_storage_v1(&created.password_envelope).unwrap();
        let PasswordEnvelopeStorageDispositionV1::Current(inspection) = disposition else {
            panic!("synthetic password envelope was not current");
        };
        let store =
            match crate::initialize_v1(&location, inspection.bootstrap_projection()).unwrap() {
                crate::InitializeStoreOutcomeV1::Created(store) => store,
                crate::InitializeStoreOutcomeV1::AlreadyInitialized => {
                    panic!("new private fixture was already initialized")
                }
            };
        Self {
            _directory: directory,
            created,
            store,
        }
    }

    fn initial_candidate(&self) -> PreparedCandidateV1 {
        self.fixture_candidate(vault_local_core::SyntheticCredentialFixtureId::SingleMcpConnection)
    }

    fn independent_initial_candidate(&self) -> PreparedCandidateV1 {
        self.fixture_candidate(vault_local_core::SyntheticCredentialFixtureId::UnconnectedApiKey)
    }

    fn fixture_candidate(
        &self,
        fixture: vault_local_core::SyntheticCredentialFixtureId,
    ) -> PreparedCandidateV1 {
        let record =
            vault_local_core::seal_synthetic_fixture_v1(&self.created.session, fixture).unwrap();
        PreparedCandidateV1::from_projection(record.persistence_projection_v1())
    }

    fn known_good_candidate(&self) -> PreparedCandidateV1 {
        self.independent_initial_candidate()
    }

    fn successor_candidate(&self, predecessor: &PreparedCandidateV1) -> PreparedCandidateV1 {
        use vault_local_core::{
            CredentialStorageAuthenticatorV1, OwnedRehydratedCredentialOutcomeV1,
            create_synthetic_successor_v1,
        };

        let authenticator = CredentialStorageAuthenticatorV1::new(&self.created.session);
        let owned = match authenticator
            .rehydrate_owned_stored_credential_v1(predecessor.envelope.clone())
            .unwrap()
        {
            OwnedRehydratedCredentialOutcomeV1::Current(owned) => owned,
            OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(_) => {
                panic!("current synthetic predecessor required an upgrade")
            }
        };
        let successor =
            create_synthetic_successor_v1(&self.created.session, owned.sealed_record()).unwrap();
        PreparedCandidateV1::from_projection(successor.persistence_projection_v1())
    }

    fn commit_prepared(
        &mut self,
        candidate: &PreparedCandidateV1,
    ) -> Result<CommitOutcomeV1, StorageError> {
        self.store.commit_prepared_candidate(candidate)
    }

    fn insert_revision_without_head_for_test(&mut self, candidate: &PreparedCandidateV1) {
        self.store
            .connection
            .execute(
                "INSERT INTO revisions VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    candidate.record_id.as_slice(),
                    candidate.revision_id.as_slice(),
                    i64::from(candidate.wire_version),
                    i64::from(candidate.suite_id),
                    i64::from(candidate.key_epoch),
                    candidate.padding_bucket,
                    candidate.envelope.as_slice(),
                ],
            )
            .unwrap();
    }

    fn install_ignore_insert_trigger_for_test(&self, table: &str) {
        let statement = match table {
            "revisions" => {
                "CREATE TRIGGER test_ignore_revision_insert \
                 BEFORE INSERT ON revisions BEGIN SELECT RAISE(IGNORE); END;"
            }
            "heads" => {
                "CREATE TRIGGER test_ignore_head_insert \
                 BEFORE INSERT ON heads BEGIN SELECT RAISE(IGNORE); END;"
            }
            "conflicts" => {
                "CREATE TRIGGER test_ignore_conflict_insert \
                 BEFORE INSERT ON conflicts BEGIN SELECT RAISE(IGNORE); END;"
            }
            _ => panic!("unsupported private trigger fixture"),
        };
        self.store.connection.execute_batch(statement).unwrap();
    }

    fn logical_snapshot(&self) -> LogicalSnapshotV1 {
        let revisions = self
            .store
            .connection
            .prepare(
                "SELECT record_id,revision_id,wire_version,suite_id,key_epoch,padding_bucket,envelope \
                 FROM revisions ORDER BY record_id,revision_id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
                    row.get(6)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let heads = self
            .store
            .connection
            .prepare("SELECT record_id,revision_id FROM heads ORDER BY record_id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let conflicts = self
            .store
            .connection
            .prepare(
                "SELECT record_id,candidate_revision_id,expected_head_revision_id,observed_head_revision_id \
                 FROM conflicts ORDER BY record_id,candidate_revision_id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        LogicalSnapshotV1 {
            revisions,
            heads,
            conflicts,
        }
    }

    fn sql_access_count(&self) -> usize {
        self.store.sql_access_count
    }

    fn head_for(&self, candidate: &PreparedCandidateV1) -> Option<Vec<u8>> {
        self.store
            .connection
            .query_row(
                "SELECT revision_id FROM heads WHERE record_id=?1",
                [candidate.record_id.as_slice()],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
    }

    fn conflict_expected(&self, candidate: &PreparedCandidateV1) -> Option<Vec<u8>> {
        self.store
            .connection
            .query_row(
                "SELECT expected_head_revision_id FROM conflicts \
                 WHERE record_id=?1 AND candidate_revision_id=?2",
                params![
                    candidate.record_id.as_slice(),
                    candidate.revision_id.as_slice()
                ],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
            .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::{PreparedCandidateV1, TestDbFixtureV1};
    use crate::{CommitOutcomeV1, StorageErrorCode};

    #[test]
    fn same_primary_key_with_different_persistent_bytes_latches_before_next_sql_access() {
        let mut fixture = TestDbFixtureV1::new();
        let committed = fixture.initial_candidate();
        fixture.commit_prepared(&committed).unwrap();
        let before = fixture.logical_snapshot();
        let mut collision = committed.clone_for_test();
        collision.flip_authenticated_body_byte_for_test();

        let error = fixture.commit_prepared(&collision).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::InvariantViolation);
        assert_eq!(fixture.logical_snapshot(), before);
        let sql_before_retry = fixture.sql_access_count();
        let known_good = fixture.known_good_candidate();
        let error = fixture.commit_prepared(&known_good).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::InvariantViolation);
        assert_eq!(fixture.sql_access_count(), sql_before_retry);
        assert_eq!(fixture.logical_snapshot(), before);
    }

    #[test]
    fn projection_envelope_metadata_mismatch_rolls_back_and_latches() {
        let mut fixture = TestDbFixtureV1::new();
        let committed = fixture.initial_candidate();
        fixture.commit_prepared(&committed).unwrap();
        let before = fixture.logical_snapshot();
        let mut mismatch = fixture.known_good_candidate();
        mismatch.change_cached_epoch_for_test();

        let error = fixture.commit_prepared(&mismatch).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::InvariantViolation);
        assert_eq!(fixture.logical_snapshot(), before);
        let sql_before_retry = fixture.sql_access_count();
        let known_good = fixture.known_good_candidate();
        let error = fixture.commit_prepared(&known_good).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::InvariantViolation);
        assert_eq!(fixture.sql_access_count(), sql_before_retry);
        assert_eq!(fixture.logical_snapshot(), before);
    }

    #[test]
    fn existing_conflict_with_changed_expected_is_an_invariant() {
        let mut fixture = TestDbFixtureV1::new();
        let initial = fixture.initial_candidate();
        fixture.commit_prepared(&initial).unwrap();
        let winner = fixture.successor_candidate(&initial);
        let stale = fixture.successor_candidate(&initial);
        fixture.commit_prepared(&winner).unwrap();
        assert!(matches!(
            fixture.commit_prepared(&stale).unwrap(),
            CommitOutcomeV1::ConflictPreserved
        ));
        let before = fixture.logical_snapshot();
        let mut changed = stale.clone_for_test();
        changed.change_expected_to_nonexistent_for_test();

        let error = fixture.commit_prepared(&changed).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::InvariantViolation);
        assert_eq!(fixture.logical_snapshot(), before);
    }

    #[test]
    fn headless_successor_is_missing_base_without_latching() {
        let mut fixture = TestDbFixtureV1::new();
        let initial = fixture.initial_candidate();
        fixture.insert_revision_without_head_for_test(&initial);
        let successor = fixture.successor_candidate(&initial);
        let before = fixture.logical_snapshot();

        let error = fixture.commit_prepared(&successor).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::MissingBase);
        assert_eq!(fixture.logical_snapshot(), before);
        let independent = fixture.independent_initial_candidate();
        assert!(matches!(
            fixture.commit_prepared(&independent).unwrap(),
            CommitOutcomeV1::Committed
        ));
    }

    #[test]
    fn initial_candidate_for_existing_record_is_preserved_as_a_conflict() {
        let mut fixture = TestDbFixtureV1::new();
        let initial = fixture.initial_candidate();
        fixture.commit_prepared(&initial).unwrap();
        let mut second = fixture.successor_candidate(&initial);
        second.clear_expected_for_test();
        let original_head = fixture.head_for(&initial);

        assert!(matches!(
            fixture.commit_prepared(&second).unwrap(),
            CommitOutcomeV1::ConflictPreserved
        ));
        assert_eq!(fixture.head_for(&initial), original_head);
        assert_eq!(fixture.conflict_expected(&second), None);
    }

    #[test]
    fn ignored_revision_insert_rolls_back_latches_and_blocks_later_sql() {
        let mut fixture = TestDbFixtureV1::new();
        fixture.install_ignore_insert_trigger_for_test("revisions");
        fixture.install_ignore_insert_trigger_for_test("heads");
        let candidate = fixture.initial_candidate();
        let before = fixture.logical_snapshot();

        let error = fixture.commit_prepared(&candidate).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::InvariantViolation);
        assert_eq!(fixture.logical_snapshot(), before);
        let sql_before_retry = fixture.sql_access_count();
        let known_good = fixture.known_good_candidate();
        let error = fixture.commit_prepared(&known_good).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::InvariantViolation);
        assert_eq!(fixture.sql_access_count(), sql_before_retry);
        assert_eq!(fixture.logical_snapshot(), before);
    }

    #[test]
    fn ignored_initial_head_insert_rolls_back_latches_and_blocks_later_sql() {
        let mut fixture = TestDbFixtureV1::new();
        fixture.install_ignore_insert_trigger_for_test("heads");
        let candidate = fixture.initial_candidate();
        let before = fixture.logical_snapshot();

        let error = fixture.commit_prepared(&candidate).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::InvariantViolation);
        assert_eq!(fixture.logical_snapshot(), before);
        let sql_before_retry = fixture.sql_access_count();
        let known_good = fixture.known_good_candidate();
        let error = fixture.commit_prepared(&known_good).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::InvariantViolation);
        assert_eq!(fixture.sql_access_count(), sql_before_retry);
        assert_eq!(fixture.logical_snapshot(), before);
    }

    #[test]
    fn ignored_conflict_insert_rolls_back_latches_and_blocks_later_sql() {
        let mut fixture = TestDbFixtureV1::new();
        let initial = fixture.initial_candidate();
        fixture.commit_prepared(&initial).unwrap();
        let winner = fixture.successor_candidate(&initial);
        fixture.commit_prepared(&winner).unwrap();
        let stale = fixture.successor_candidate(&initial);
        fixture.install_ignore_insert_trigger_for_test("conflicts");
        let before = fixture.logical_snapshot();

        let error = fixture.commit_prepared(&stale).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::InvariantViolation);
        assert_eq!(fixture.logical_snapshot(), before);
        let sql_before_retry = fixture.sql_access_count();
        let known_good = fixture.known_good_candidate();
        let error = fixture.commit_prepared(&known_good).unwrap_err();
        assert_eq!(error.code(), StorageErrorCode::InvariantViolation);
        assert_eq!(fixture.sql_access_count(), sql_before_retry);
        assert_eq!(fixture.logical_snapshot(), before);
    }

    fn _private_type_is_never_public(_: PreparedCandidateV1) {}
}
