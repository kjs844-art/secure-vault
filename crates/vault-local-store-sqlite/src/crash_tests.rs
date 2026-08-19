use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use vault_crypto::{
    MasterPassword, PasswordEnvelopeStorageDispositionV1, create_vault_v0alpha1,
    inspect_password_envelope_for_storage_v1, unlock_vault_v0alpha1,
};
use vault_local_core::{
    CredentialStorageAuthenticatorV1, StoredCredentialAuthenticationOutcomeV1,
    SyntheticCredentialFixtureId, create_synthetic_successor_v1, seal_synthetic_fixture_v1,
};

use crate::commit::{TransactionCrashPointV1, install_transaction_observer_for_test};
use crate::{
    CommitOutcomeV1, ExistingVaultPreflightOutcomeV1, InitializeStoreOutcomeV1,
    StoreLocationPolicyV1, initialize_v1, preflight_existing_v1,
};

const FAILPOINT_ENV: &str = "SVLT_SYNTHETIC_CRASH_FAILPOINT";
const ROOT_ENV: &str = "SVLT_SYNTHETIC_CRASH_ROOT";
const READY_ENV: &str = "SVLT_SYNTHETIC_CRASH_READY";
const DATABASE_NAME: &str = "vault.sqlite3";
const PASSWORD_TEXT: &str = "DEMO_VALUE_ONLY_crash_atomicity.invalid";
const READY_BYTE: &[u8] = b"1";
const CHILD_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Eq, PartialEq)]
enum SyntheticCrashCaseV1 {
    InitialBefore,
    InitialAfter,
    ConflictBefore,
    ConflictAfter,
}

type ConflictVisibilityV1 = (Vec<u8>, Option<Vec<u8>>, Vec<u8>);

impl SyntheticCrashCaseV1 {
    const fn marker(self) -> &'static str {
        match self {
            Self::InitialBefore => "SYNTHETIC_INITIAL_BEFORE_COMMIT",
            Self::InitialAfter => "SYNTHETIC_INITIAL_AFTER_COMMIT",
            Self::ConflictBefore => "SYNTHETIC_CONFLICT_BEFORE_COMMIT",
            Self::ConflictAfter => "SYNTHETIC_CONFLICT_AFTER_COMMIT",
        }
    }

    const fn point(self) -> TransactionCrashPointV1 {
        match self {
            Self::InitialBefore => TransactionCrashPointV1::InitialBefore,
            Self::InitialAfter => TransactionCrashPointV1::InitialAfter,
            Self::ConflictBefore => TransactionCrashPointV1::ConflictBefore,
            Self::ConflictAfter => TransactionCrashPointV1::ConflictAfter,
        }
    }

    const fn is_before(self) -> bool {
        matches!(self, Self::InitialBefore | Self::ConflictBefore)
    }

    fn parse(marker: &str) -> Option<Self> {
        match marker {
            "SYNTHETIC_INITIAL_BEFORE_COMMIT" => Some(Self::InitialBefore),
            "SYNTHETIC_INITIAL_AFTER_COMMIT" => Some(Self::InitialAfter),
            "SYNTHETIC_CONFLICT_BEFORE_COMMIT" => Some(Self::ConflictBefore),
            "SYNTHETIC_CONFLICT_AFTER_COMMIT" => Some(Self::ConflictAfter),
            _ => None,
        }
    }
}

#[derive(Default)]
struct ReopenedShapeV1 {
    revisions: usize,
    heads: usize,
    conflicts: usize,
    head_is_root: bool,
    head_parent_is_root: bool,
    conflict_expected_is_root: bool,
    conflict_observed_is_head: bool,
    conflict_candidate_is_not_head: bool,
}

#[test]
fn initial_commit_is_atomic_across_process_termination() {
    let before = run_case(SyntheticCrashCaseV1::InitialBefore);
    assert_eq!(before.revisions, 0);
    assert_eq!(before.heads, 0);
    assert_eq!(before.conflicts, 0);

    let after = run_case(SyntheticCrashCaseV1::InitialAfter);
    assert_eq!(after.revisions, 1);
    assert_eq!(after.heads, 1);
    assert_eq!(after.conflicts, 0);
    assert!(after.head_is_root);
}

#[test]
fn stale_conflict_is_atomic_and_never_moves_the_head() {
    let before = run_case(SyntheticCrashCaseV1::ConflictBefore);
    assert_eq!(before.revisions, 2);
    assert_eq!(before.heads, 1);
    assert_eq!(before.conflicts, 0);
    assert!(before.head_parent_is_root);

    let after = run_case(SyntheticCrashCaseV1::ConflictAfter);
    assert_eq!(after.revisions, 3);
    assert_eq!(after.heads, 1);
    assert_eq!(after.conflicts, 1);
    assert!(after.head_parent_is_root);
    assert!(after.conflict_expected_is_root);
    assert!(after.conflict_observed_is_head);
    assert!(after.conflict_candidate_is_not_head);
}

fn run_case(case: SyntheticCrashCaseV1) -> ReopenedShapeV1 {
    let directory = tempfile::tempdir().expect("synthetic crash directory creation failed");
    let ready_path = directory.path().join("ready");
    let mut child = spawn_child(case, directory.path(), &ready_path);

    if case.is_before() {
        wait_for_readiness(&mut child, &ready_path);
        child.kill().expect("owned child termination failed");
        child.wait().expect("owned child wait failed");
    } else {
        let status = wait_for_exit(&mut child);
        assert!(status.success(), "after-commit child did not exit cleanly");
        assert_eq!(
            fs::read(&ready_path).expect("after-commit readiness read failed"),
            READY_BYTE
        );
    }

    reopen_through_normal_preflight(directory.path())
}

fn spawn_child(case: SyntheticCrashCaseV1, root: &Path, ready_path: &Path) -> Child {
    Command::new(std::env::current_exe().expect("lib-test executable lookup failed"))
        .args([
            "--exact",
            "crash_tests::synthetic_crash_child_entrypoint",
            "--ignored",
            "--test-threads=1",
        ])
        .env(FAILPOINT_ENV, case.marker())
        .env(ROOT_ENV, root)
        .env(READY_ENV, ready_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("lib-test child spawn failed")
}

fn wait_for_readiness(child: &mut Child, ready_path: &Path) {
    let deadline = Instant::now() + CHILD_TIMEOUT;
    loop {
        if fs::read(ready_path).ok().as_deref() == Some(READY_BYTE) {
            return;
        }
        if child
            .try_wait()
            .expect("owned child status check failed")
            .is_some()
        {
            panic!("before-commit child exited before readiness");
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("before-commit readiness timed out");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_exit(child: &mut Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + CHILD_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().expect("owned child status check failed") {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("after-commit child timed out");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "exact lib-test child entrypoint; invoked only by the parent crash tests"]
fn synthetic_crash_child_entrypoint() {
    let marker = std::env::var(FAILPOINT_ENV).expect("child failpoint is missing");
    let case = SyntheticCrashCaseV1::parse(&marker).expect("child failpoint is not allowlisted");
    assert_eq!(case.marker(), marker);
    let root = PathBuf::from(std::env::var_os(ROOT_ENV).expect("child root is missing"));
    let _ = std::env::var_os(READY_ENV).expect("child readiness path is missing");
    let policy = StoreLocationPolicyV1::new(&root).expect("child location policy failed");
    let location = policy
        .location(DATABASE_NAME)
        .expect("child database location failed");
    let password = MasterPassword::from_utf8(PASSWORD_TEXT.to_owned())
        .expect("synthetic crash password failed");
    let created = create_vault_v0alpha1(&password).expect("synthetic child vault creation failed");
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) =
        inspect_password_envelope_for_storage_v1(&created.password_envelope)
            .expect("synthetic child password inspection failed")
    else {
        panic!("synthetic child password envelope was not current");
    };
    let mut store = match initialize_v1(&location, inspection.bootstrap_projection())
        .expect("synthetic child initialization failed")
    {
        InitializeStoreOutcomeV1::Created(store) => store,
        InitializeStoreOutcomeV1::AlreadyInitialized => {
            panic!("synthetic child store was already initialized")
        }
    };
    let initial = seal_synthetic_fixture_v1(
        &created.session,
        SyntheticCredentialFixtureId::SingleMcpConnection,
    )
    .expect("synthetic initial record sealing failed");

    if matches!(
        case,
        SyntheticCrashCaseV1::InitialBefore | SyntheticCrashCaseV1::InitialAfter
    ) {
        install_transaction_observer_for_test(transaction_observer);
        let outcome = store
            .commit_candidate(initial.persistence_projection_v1())
            .expect("synthetic initial commit failed");
        assert!(matches!(outcome, CommitOutcomeV1::Committed));
        return;
    }

    assert!(matches!(
        store
            .commit_candidate(initial.persistence_projection_v1())
            .expect("synthetic base commit failed"),
        CommitOutcomeV1::Committed
    ));
    let winner = create_synthetic_successor_v1(&created.session, &initial)
        .expect("synthetic winner creation failed");
    let stale = create_synthetic_successor_v1(&created.session, &initial)
        .expect("synthetic stale creation failed");
    assert!(matches!(
        store
            .commit_candidate(winner.persistence_projection_v1())
            .expect("synthetic winner commit failed"),
        CommitOutcomeV1::Committed
    ));
    install_transaction_observer_for_test(transaction_observer);
    assert!(matches!(
        store
            .commit_candidate(stale.persistence_projection_v1())
            .expect("synthetic stale commit failed"),
        CommitOutcomeV1::ConflictPreserved
    ));
}

fn transaction_observer(point: TransactionCrashPointV1) {
    let marker = std::env::var(FAILPOINT_ENV).expect("observer failpoint is missing");
    let case = SyntheticCrashCaseV1::parse(&marker).expect("observer failpoint is not allowlisted");
    if point != case.point() {
        return;
    }
    let ready =
        PathBuf::from(std::env::var_os(READY_ENV).expect("observer readiness path is missing"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(ready)
        .expect("readiness create-new failed");
    file.write_all(READY_BYTE)
        .expect("readiness byte write failed");
    file.sync_all().expect("readiness sync failed");
    if case.is_before() {
        loop {
            thread::park();
        }
    }
    std::process::exit(0);
}

fn reopen_through_normal_preflight(root: &Path) -> ReopenedShapeV1 {
    let policy = StoreLocationPolicyV1::new(root).expect("parent location policy failed");
    let location = policy
        .location(DATABASE_NAME)
        .expect("parent database location failed");
    let mut preflight =
        match preflight_existing_v1(&location).expect("normal structural preflight failed") {
            ExistingVaultPreflightOutcomeV1::Current(preflight) => preflight,
            _ => panic!("crash result did not pass normal structural preflight"),
        };
    let password = MasterPassword::from_utf8(PASSWORD_TEXT.to_owned())
        .expect("synthetic parent password failed");
    let session = unlock_vault_v0alpha1(&password, preflight.password_envelope())
        .expect("synthetic parent unlock failed");
    let authenticator = CredentialStorageAuthenticatorV1::new(&session);
    let mut nodes = Vec::new();
    preflight
        .with_revisions(|revision| {
            let StoredCredentialAuthenticationOutcomeV1::Current(receipt) = authenticator
                .authenticate_stored_credential_v1(revision.envelope())
                .map_err(|_| {
                    crate::StorageError::new(crate::StorageErrorCode::AuthenticationFailed)
                })?
            else {
                return Err(crate::StorageError::new(
                    crate::StorageErrorCode::CryptoUpgradeRequired,
                ));
            };
            nodes.push((
                *receipt.record_id().as_bytes(),
                *receipt.revision_id().as_bytes(),
                receipt
                    .parent_revision_id()
                    .map(|parent| *parent.as_bytes()),
            ));
            Ok(())
        })
        .expect("normal revision streaming failed");
    let authenticated = preflight
        .authenticate_current_revisions(&authenticator)
        .expect("normal preflight authentication failed")
        .into_authenticated()
        .expect("crash result did not authenticate normally");
    let heads: Vec<_> = authenticated
        .current_heads()
        .iter()
        .map(|head| {
            let projection = head.sealed_record().persistence_projection_v1();
            (
                *projection.record_id().as_bytes(),
                *projection.revision_id().as_bytes(),
            )
        })
        .collect();
    drop(authenticated);

    let root_revision = nodes
        .iter()
        .find_map(|(_, revision, parent)| parent.is_none().then_some(*revision));
    let head = heads.first().map(|(_, revision)| *revision);
    let head_parent = head.and_then(|head_revision| {
        nodes
            .iter()
            .find(|(_, revision, _)| *revision == head_revision)
            .and_then(|(_, _, parent)| *parent)
    });

    let connection = Connection::open_with_flags(
        location.database_path(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .expect("test-only read-only visibility connection failed");
    let revision_count: i64 = connection
        .query_row("SELECT count(*) FROM revisions", [], |row| row.get(0))
        .expect("test-only revision count failed");
    let head_count: i64 = connection
        .query_row("SELECT count(*) FROM heads", [], |row| row.get(0))
        .expect("test-only head count failed");
    let conflict_count: i64 = connection
        .query_row("SELECT count(*) FROM conflicts", [], |row| row.get(0))
        .expect("test-only conflict count failed");
    let conflict: Option<ConflictVisibilityV1> = connection
        .query_row(
            "SELECT candidate_revision_id,expected_head_revision_id,observed_head_revision_id FROM conflicts",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .expect("test-only conflict relationship read failed");
    let conflict_expected_is_root = conflict
        .as_ref()
        .zip(root_revision)
        .is_some_and(|((_, expected, _), root)| expected.as_deref() == Some(root.as_slice()));
    let conflict_observed_is_head = conflict
        .as_ref()
        .zip(head)
        .is_some_and(|((_, _, observed), head)| observed.as_slice() == head.as_slice());
    let conflict_candidate_is_not_head = conflict
        .as_ref()
        .zip(head)
        .is_some_and(|((candidate, _, _), head)| candidate.as_slice() != head.as_slice());

    ReopenedShapeV1 {
        revisions: usize::try_from(revision_count).expect("revision count conversion failed"),
        heads: usize::try_from(head_count).expect("head count conversion failed"),
        conflicts: usize::try_from(conflict_count).expect("conflict count conversion failed"),
        head_is_root: head.is_some() && head == root_revision,
        head_parent_is_root: head_parent.is_some() && head_parent == root_revision,
        conflict_expected_is_root,
        conflict_observed_is_head,
        conflict_candidate_is_not_head,
    }
}
