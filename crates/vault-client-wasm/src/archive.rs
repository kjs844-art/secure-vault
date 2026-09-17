//! Bounded synthetic-demo transport of existing canonical encrypted envelopes.
//!
//! The password is public test data. Encryption here exercises the storage
//! boundary; it provides no confidentiality against someone with this app.
//! This framing is not a signed manifest or a rollback/origin guarantee. An
//! authenticated, well-formed archive is not proof of its synthetic origin.
//! Callers must preserve stored bytes on every error and never auto-reset them.

use vault_client_bridge::{
    ClientBridgeErrorCodeV1, ClientCatalogSnapshotV1, project_authenticated_catalog_v1,
};
use vault_crypto::{
    CreatedVaultV0Alpha1, CryptoErrorCode, MasterPassword, PasswordEnvelopeStorageDispositionV1,
    RecordEnvelopeStorageDispositionV1, create_vault_v0alpha1,
    inspect_password_envelope_for_storage_v1, inspect_record_envelope_for_storage_v1,
    unlock_vault_v0alpha1,
};
use vault_local_core::{
    CredentialStorageAuthenticatorV1, LocalVaultErrorCode, OwnedRehydratedCredentialOutcomeV1,
    SyntheticConnectionSelectionV1, SyntheticCredentialFixtureId, SyntheticRegistrationSelectionV1,
    create_synthetic_connection_successor_v1, seal_synthetic_fixture_v1,
    seal_synthetic_registration_v1,
};

const ARCHIVE_MAGIC: &[u8; 8] = b"KATLDEMO";
const ARCHIVE_VERSION: u32 = 1;
const MUTABLE_ARCHIVE_VERSION: u32 = 2;
const HISTORY_ARCHIVE_VERSION: u32 = 3;
const STAGING_ARCHIVE_VERSION: u32 = 4;
const RECORD_COUNT: usize = 3;
const MAX_RECORD_COUNT: usize = 128;
const MAX_REVISION_COUNT: usize = 512;
const HEADER_BYTES: usize = 16;
const MAX_ENVELOPE_BYTES: usize = 65_536;
const MAX_ARCHIVE_BYTES: usize = 512 * 1_024;
const DEMO_PASSWORD: &str = "DEMO_VALUE_ONLY_wasm_catalog";

#[path = "archive_history.rs"]
mod history;

#[path = "archive_capacity.rs"]
mod capacity;

#[path = "archive_rotation.rs"]
mod rotation;
pub(crate) use rotation::{
    ArchiveRotationChecklistV1, ArchiveRotationFixtureV1, ArchiveRotationGenerationV1,
    ArchiveRotationReadinessStateV1, create_rotation_cutover_candidate, inspect_rotation_checklist,
};

#[path = "archive_staging.rs"]
mod staging;
pub(crate) use staging::{
    create_rotation_cutover_from_stage_candidate, create_rotation_stage_candidate,
    inspect_rotation_stage,
};

#[cfg(test)]
#[path = "archive_history_tests.rs"]
mod history_tests;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ArchiveError {
    InvalidArchive,
    UpgradeRequired,
    LimitsExceeded,
    AuthenticationFailed,
    CryptoFailure,
}

impl ArchiveError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::InvalidArchive => "INVALID_ARCHIVE",
            Self::UpgradeRequired => "UPGRADE_REQUIRED",
            Self::LimitsExceeded => "LIMITS_EXCEEDED",
            Self::AuthenticationFailed => "AUTHENTICATION_FAILED",
            Self::CryptoFailure => "CRYPTO_FAILURE",
        }
    }
}

struct ParsedArchive<'a> {
    version: u32,
    password_envelope: &'a [u8],
    // Immutable revisions. In legacy archives every envelope is a head.
    records: Vec<&'a [u8]>,
    // Ordered indexes into records; no record/revision ID crosses the UI boundary.
    heads: Vec<usize>,
    // Append-only encrypted siblings, never canonical revisions or heads.
    stages: Vec<StagedEnvelope<'a>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StagedEnvelope<'a> {
    base_index: usize,
    envelope: &'a [u8],
}

pub(crate) fn create_archive() -> Result<Vec<u8>, ArchiveError> {
    let (created, records) = create_parts()?;
    encode_archive(&created.password_envelope, &records)
}

/// The existing ephemeral demo can share fixture creation without doing a
/// second password KDF. No archive or key is returned with the display rows.
pub(crate) fn create_catalog() -> Result<ClientCatalogSnapshotV1, ArchiveError> {
    let (created, records) = create_parts()?;
    project_records(&created.session, records.iter().map(Vec::as_slice))
}

pub(crate) fn open_archive(input: &[u8]) -> Result<ClientCatalogSnapshotV1, ArchiveError> {
    // Lengths, full framing and every envelope shape are checked before
    // password KDF work. Parsing borrows the bounded input without copying it.
    let parsed = parse_archive(input)?;
    inspect_envelopes(&parsed)?;
    let password = demo_password()?;
    let session = unlock_vault_v0alpha1(&password, parsed.password_envelope)
        .map_err(|error| map_crypto_error(error.code()))?;
    project_archive(&session, &parsed)
}

/// Append one closed synthetic selection after authenticating the entire input.
/// All original encrypted envelopes are borrowed unchanged into a v2/v3 frame.
/// This returns ciphertext only and has no storage or origin/rollback authority.
pub(crate) fn append_registration(
    input: &[u8],
    profile_id: u32,
    credential_id: u32,
    connection_ids: &[u32],
) -> Result<Vec<u8>, ArchiveError> {
    let selection =
        SyntheticRegistrationSelectionV1::from_ids(profile_id, credential_id, connection_ids)
            .map_err(|error| map_local_error(error.code()))?;
    let parsed = parse_archive(input)?;
    inspect_envelopes(&parsed)?;
    if parsed.heads.len() >= MAX_RECORD_COUNT
        || parsed.records.len() + parsed.stages.len() >= MAX_REVISION_COUNT
    {
        return Err(ArchiveError::LimitsExceeded);
    }
    let password = demo_password()?;
    let session = unlock_vault_v0alpha1(&password, parsed.password_envelope)
        .map_err(|error| map_crypto_error(error.code()))?;
    // Reject every corrupt/future payload and duplicate identity before sealing.
    drop(project_archive(&session, &parsed)?);
    let sealed = seal_synthetic_registration_v1(&session, &selection)
        .map_err(|error| map_local_error(error.code()))?;
    let projection = sealed.persistence_projection_v1();
    let mut heads = parsed.heads;
    let mut records = parsed.records;
    heads.push(records.len());
    records.push(projection.envelope());
    let candidate = if parsed.version == STAGING_ARCHIVE_VERSION {
        staging::encode(parsed.password_envelope, &records, &heads, &parsed.stages)
    } else if parsed.version == HISTORY_ARCHIVE_VERSION {
        history::encode(parsed.password_envelope, &records, &heads)
    } else {
        encode_archive_version(MUTABLE_ARCHIVE_VERSION, parsed.password_envelope, &records)
    }?;
    verify_candidate(&session, candidate)
}

/// Edit the head at a reference in THIS exact archive, never a later archive.
/// The host must bind its displayed snapshot and CAS expected bytes to input.
/// Append a successor and preserve every old envelope; this does not commit it.
pub(crate) fn edit_connections(
    input: &[u8],
    reference: u32,
    connection_ids: &[u32],
) -> Result<Vec<u8>, ArchiveError> {
    let selection = SyntheticConnectionSelectionV1::from_ids(connection_ids)
        .map_err(|error| map_local_error(error.code()))?;
    let parsed = parse_archive(input)?;
    inspect_envelopes(&parsed)?;
    let reference = usize::try_from(reference).map_err(|_| ArchiveError::InvalidArchive)?;
    let &head = parsed
        .heads
        .get(reference)
        .ok_or(ArchiveError::InvalidArchive)?;
    if parsed.records.len() + parsed.stages.len() >= MAX_REVISION_COUNT {
        return Err(ArchiveError::LimitsExceeded);
    }
    let session = unlock_vault_v0alpha1(&demo_password()?, parsed.password_envelope)
        .map_err(|error| map_crypto_error(error.code()))?;
    // Includes non-head revisions. Legacy open remains compatible, but a legacy
    // successor without its ancestors must not be promoted into fabricated history.
    drop(project_archive(&session, &parsed)?);
    if parsed.version < HISTORY_ARCHIVE_VERSION {
        history::validate(&session, &parsed)?;
    }
    let predecessor = match CredentialStorageAuthenticatorV1::new(&session)
        .rehydrate_owned_stored_credential_v1(parsed.records[head].to_vec())
        .map_err(|error| map_local_error(error.code()))?
    {
        OwnedRehydratedCredentialOutcomeV1::Current(record) => record,
        OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(_) => {
            return Err(ArchiveError::UpgradeRequired);
        }
    };
    let successor =
        create_synthetic_connection_successor_v1(&session, predecessor.sealed_record(), &selection)
            .map_err(|error| map_local_error(error.code()))?;
    let before = predecessor.sealed_record().persistence_projection_v1();
    let after = successor.persistence_projection_v1();
    if before.record_id() != after.record_id()
        || after.expected_revision_id() != Some(before.revision_id())
        || before.revision_id() == after.revision_id()
    {
        return Err(ArchiveError::InvalidArchive);
    }
    let mut records = parsed.records;
    let mut heads = parsed.heads;
    heads[reference] = records.len();
    records.push(after.envelope());
    let candidate = if parsed.version == STAGING_ARCHIVE_VERSION {
        staging::encode(parsed.password_envelope, &records, &heads, &parsed.stages)
    } else {
        history::encode(parsed.password_envelope, &records, &heads)
    }?;
    verify_candidate(&session, candidate)
}

// Validate the assembled output too: even a generated ID collision must fail
// before ciphertext can leave this API for a caller's eventual storage CAS.
fn verify_candidate(
    session: &vault_crypto::VaultSession,
    candidate: Vec<u8>,
) -> Result<Vec<u8>, ArchiveError> {
    let parsed = parse_archive(&candidate)?;
    inspect_envelopes(&parsed)?;
    drop(project_archive(session, &parsed)?);
    // Only newly generated revision candidates must retain enough room to
    // complete every active rotation. Reads/restores preserve old full archives.
    capacity::validate_candidate(session, &parsed, candidate.len())?;
    Ok(candidate)
}

fn project_archive(
    session: &vault_crypto::VaultSession,
    parsed: &ParsedArchive<'_>,
) -> Result<ClientCatalogSnapshotV1, ArchiveError> {
    if parsed.version >= HISTORY_ARCHIVE_VERSION {
        history::validate(session, parsed)?;
    }
    if parsed.version == STAGING_ARCHIVE_VERSION {
        staging::validate(session, parsed)?;
    }
    project_records(
        session,
        parsed.heads.iter().map(|&head| parsed.records[head]),
    )
}

fn demo_password() -> Result<MasterPassword, ArchiveError> {
    MasterPassword::from_utf8(DEMO_PASSWORD.to_owned()).map_err(|_| ArchiveError::CryptoFailure)
}

fn create_parts() -> Result<(CreatedVaultV0Alpha1, Vec<Vec<u8>>), ArchiveError> {
    let password = demo_password()?;
    let created =
        create_vault_v0alpha1(&password).map_err(|error| map_crypto_error(error.code()))?;
    let mut records = Vec::with_capacity(RECORD_COUNT);
    for fixture in [
        SyntheticCredentialFixtureId::UnconnectedApiKey,
        SyntheticCredentialFixtureId::SingleMcpConnection,
        SyntheticCredentialFixtureId::MultipleConsumers,
    ] {
        let sealed = seal_synthetic_fixture_v1(&created.session, fixture)
            .map_err(|error| map_local_error(error.code()))?;
        records.push(sealed.persistence_projection_v1().envelope().to_vec());
    }
    Ok((created, records))
}

fn project_records<'a>(
    session: &vault_crypto::VaultSession,
    records: impl IntoIterator<Item = &'a [u8]>,
) -> Result<ClientCatalogSnapshotV1, ArchiveError> {
    let authenticator = CredentialStorageAuthenticatorV1::new(session);
    let mut heads = Vec::with_capacity(RECORD_COUNT);
    for envelope in records {
        match authenticator
            .rehydrate_owned_stored_credential_v1(envelope.to_vec())
            .map_err(|error| map_local_error(error.code()))?
        {
            OwnedRehydratedCredentialOutcomeV1::Current(head) => heads.push(head),
            OwnedRehydratedCredentialOutcomeV1::UpgradeRequired(_) => {
                return Err(ArchiveError::UpgradeRequired);
            }
        }
    }
    project_authenticated_catalog_v1(session, &heads).map_err(|error| match error.code() {
        ClientBridgeErrorCodeV1::NonCanonicalEncoding | ClientBridgeErrorCodeV1::InvalidItem => {
            ArchiveError::InvalidArchive
        }
        ClientBridgeErrorCodeV1::LimitsExceeded => ArchiveError::LimitsExceeded,
        ClientBridgeErrorCodeV1::AuthenticationFailed => ArchiveError::AuthenticationFailed,
        ClientBridgeErrorCodeV1::UpgradeRequired => ArchiveError::UpgradeRequired,
        ClientBridgeErrorCodeV1::RngUnavailable | ClientBridgeErrorCodeV1::CryptoFailure => {
            ArchiveError::CryptoFailure
        }
    })
}

fn encode_archive(password_envelope: &[u8], records: &[Vec<u8>]) -> Result<Vec<u8>, ArchiveError> {
    let records: Vec<&[u8]> = records.iter().map(Vec::as_slice).collect();
    encode_archive_version(ARCHIVE_VERSION, password_envelope, &records)
}

fn encode_archive_version(
    version: u32,
    password_envelope: &[u8],
    records: &[&[u8]],
) -> Result<Vec<u8>, ArchiveError> {
    if version == HISTORY_ARCHIVE_VERSION || version == STAGING_ARCHIVE_VERSION {
        // v3 requires an explicit revision count and head map; use history::encode.
        return Err(ArchiveError::InvalidArchive);
    }
    check_record_count(version, records.len())?;
    let mut size = HEADER_BYTES;
    for envelope in std::iter::once(password_envelope).chain(records.iter().copied()) {
        check_envelope_length(envelope.len())?;
        size = size
            .checked_add(4)
            .and_then(|size| size.checked_add(envelope.len()))
            .ok_or(ArchiveError::LimitsExceeded)?;
    }
    if size > MAX_ARCHIVE_BYTES {
        return Err(ArchiveError::LimitsExceeded);
    }
    let mut archive = Vec::with_capacity(size);
    archive.extend_from_slice(ARCHIVE_MAGIC);
    archive.extend_from_slice(&version.to_le_bytes());
    archive.extend_from_slice(&(records.len() as u32).to_le_bytes());
    for envelope in std::iter::once(password_envelope).chain(records.iter().copied()) {
        let length = u32::try_from(envelope.len()).map_err(|_| ArchiveError::LimitsExceeded)?;
        archive.extend_from_slice(&length.to_le_bytes());
        archive.extend_from_slice(envelope);
    }
    Ok(archive)
}

fn parse_archive(input: &[u8]) -> Result<ParsedArchive<'_>, ArchiveError> {
    if input.len() > MAX_ARCHIVE_BYTES {
        return Err(ArchiveError::LimitsExceeded);
    }
    let mut cursor = Cursor { input, position: 0 };
    if cursor.take(ARCHIVE_MAGIC.len())? != ARCHIVE_MAGIC {
        return Err(ArchiveError::InvalidArchive);
    }
    let version = cursor.u32()?;
    match version {
        ARCHIVE_VERSION
        | MUTABLE_ARCHIVE_VERSION
        | HISTORY_ARCHIVE_VERSION
        | STAGING_ARCHIVE_VERSION => {}
        version if version > STAGING_ARCHIVE_VERSION => return Err(ArchiveError::UpgradeRequired),
        _ => return Err(ArchiveError::InvalidArchive),
    }
    let record_count = usize::try_from(cursor.u32()?).map_err(|_| ArchiveError::LimitsExceeded)?;
    check_record_count(version, record_count)?;
    let revision_count = if version >= HISTORY_ARCHIVE_VERSION {
        usize::try_from(cursor.u32()?).map_err(|_| ArchiveError::LimitsExceeded)?
    } else {
        record_count
    };
    let stage_count = if version == STAGING_ARCHIVE_VERSION {
        usize::try_from(cursor.u32()?).map_err(|_| ArchiveError::LimitsExceeded)?
    } else {
        0
    };
    if revision_count
        .checked_add(stage_count)
        .ok_or(ArchiveError::LimitsExceeded)?
        > MAX_REVISION_COUNT
    {
        return Err(ArchiveError::LimitsExceeded);
    }
    if revision_count < record_count {
        return Err(ArchiveError::InvalidArchive);
    }
    let password_envelope = cursor.envelope()?;
    let mut records = Vec::with_capacity(revision_count);
    for _ in 0..revision_count {
        records.push(cursor.envelope()?);
    }
    let heads = if version >= HISTORY_ARCHIVE_VERSION {
        let mut heads = Vec::with_capacity(record_count);
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..record_count {
            let index = usize::try_from(cursor.u32()?).map_err(|_| ArchiveError::LimitsExceeded)?;
            if index >= revision_count || !seen.insert(index) {
                return Err(ArchiveError::InvalidArchive);
            }
            heads.push(index);
        }
        heads
    } else {
        (0..record_count).collect()
    };
    let mut stages = Vec::with_capacity(stage_count);
    for _ in 0..stage_count {
        let base_index =
            usize::try_from(cursor.u32()?).map_err(|_| ArchiveError::LimitsExceeded)?;
        if base_index >= revision_count {
            return Err(ArchiveError::InvalidArchive);
        }
        stages.push(StagedEnvelope {
            base_index,
            envelope: cursor.envelope()?,
        });
    }
    if cursor.position != input.len() {
        return Err(ArchiveError::InvalidArchive);
    }
    Ok(ParsedArchive {
        version,
        password_envelope,
        records,
        heads,
        stages,
    })
}

fn check_record_count(version: u32, count: usize) -> Result<(), ArchiveError> {
    match version {
        ARCHIVE_VERSION if count == RECORD_COUNT => Ok(()),
        ARCHIVE_VERSION => Err(ArchiveError::InvalidArchive),
        MUTABLE_ARCHIVE_VERSION | HISTORY_ARCHIVE_VERSION | STAGING_ARCHIVE_VERSION
            if count > MAX_RECORD_COUNT =>
        {
            Err(ArchiveError::LimitsExceeded)
        }
        MUTABLE_ARCHIVE_VERSION | HISTORY_ARCHIVE_VERSION | STAGING_ARCHIVE_VERSION
            if count >= RECORD_COUNT =>
        {
            Ok(())
        }
        MUTABLE_ARCHIVE_VERSION | HISTORY_ARCHIVE_VERSION | STAGING_ARCHIVE_VERSION => {
            Err(ArchiveError::InvalidArchive)
        }
        version if version > STAGING_ARCHIVE_VERSION => Err(ArchiveError::UpgradeRequired),
        _ => Err(ArchiveError::InvalidArchive),
    }
}

fn inspect_envelopes(parsed: &ParsedArchive<'_>) -> Result<(), ArchiveError> {
    match inspect_password_envelope_for_storage_v1(parsed.password_envelope)
        .map_err(|error| map_crypto_error(error.code()))?
    {
        PasswordEnvelopeStorageDispositionV1::Current(_) => {}
        PasswordEnvelopeStorageDispositionV1::FutureWire(_)
        | PasswordEnvelopeStorageDispositionV1::UnsupportedSuite(_) => {
            return Err(ArchiveError::UpgradeRequired);
        }
    }
    for envelope in parsed
        .records
        .iter()
        .copied()
        .chain(parsed.stages.iter().map(|stage| stage.envelope))
    {
        match inspect_record_envelope_for_storage_v1(envelope)
            .map_err(|error| map_crypto_error(error.code()))?
        {
            RecordEnvelopeStorageDispositionV1::Current(_) => {}
            RecordEnvelopeStorageDispositionV1::FutureWire(_)
            | RecordEnvelopeStorageDispositionV1::UnsupportedSuite(_) => {
                return Err(ArchiveError::UpgradeRequired);
            }
        }
    }
    Ok(())
}

struct Cursor<'a> {
    input: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, length: usize) -> Result<&'a [u8], ArchiveError> {
        let end = self
            .position
            .checked_add(length)
            .ok_or(ArchiveError::LimitsExceeded)?;
        let bytes = self
            .input
            .get(self.position..end)
            .ok_or(ArchiveError::InvalidArchive)?;
        self.position = end;
        Ok(bytes)
    }

    fn u32(&mut self) -> Result<u32, ArchiveError> {
        let bytes = self
            .take(4)?
            .try_into()
            .map_err(|_| ArchiveError::InvalidArchive)?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn envelope(&mut self) -> Result<&'a [u8], ArchiveError> {
        let length = usize::try_from(self.u32()?).map_err(|_| ArchiveError::LimitsExceeded)?;
        check_envelope_length(length)?;
        self.take(length)
    }
}

fn check_envelope_length(length: usize) -> Result<(), ArchiveError> {
    match length {
        0 => Err(ArchiveError::InvalidArchive),
        length if length > MAX_ENVELOPE_BYTES => Err(ArchiveError::LimitsExceeded),
        _ => Ok(()),
    }
}

fn map_crypto_error(code: CryptoErrorCode) -> ArchiveError {
    match code {
        CryptoErrorCode::UnsupportedVersion | CryptoErrorCode::UnsupportedSuite => {
            ArchiveError::UpgradeRequired
        }
        CryptoErrorCode::LimitsExceeded => ArchiveError::LimitsExceeded,
        CryptoErrorCode::AuthenticationFailed => ArchiveError::AuthenticationFailed,
        CryptoErrorCode::RngUnavailable => ArchiveError::CryptoFailure,
        CryptoErrorCode::NonCanonicalEncoding
        | CryptoErrorCode::InvalidLength
        | CryptoErrorCode::KdfParamsRejected => ArchiveError::InvalidArchive,
    }
}

fn map_local_error(code: LocalVaultErrorCode) -> ArchiveError {
    match code {
        LocalVaultErrorCode::NonCanonicalEncoding | LocalVaultErrorCode::InvalidItem => {
            ArchiveError::InvalidArchive
        }
        LocalVaultErrorCode::LimitsExceeded => ArchiveError::LimitsExceeded,
        LocalVaultErrorCode::AuthenticationFailed => ArchiveError::AuthenticationFailed,
        LocalVaultErrorCode::RngUnavailable | LocalVaultErrorCode::CryptoFailure => {
            ArchiveError::CryptoFailure
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::OnceLock;

    use super::*;

    fn fixture() -> &'static [u8] {
        static ENCRYPTED_FIXTURE: OnceLock<Vec<u8>> = OnceLock::new();
        ENCRYPTED_FIXTURE.get_or_init(|| create_archive().unwrap())
    }

    fn assert_rejected_unchanged(bytes: &[u8], expected: ArchiveError) {
        let before = bytes.to_vec();
        let error = match open_archive(bytes) {
            Ok(_) => panic!("invalid synthetic archive was accepted"),
            Err(error) => error,
        };
        assert_eq!(error, expected);
        assert!(bytes == before, "rejected archive bytes changed");
        assert_eq!(append_registration(bytes, 0, 0, &[]).err(), Some(expected));
        assert!(bytes == before, "rejected append input bytes changed");
    }

    fn fixture_parts() -> (Vec<u8>, Vec<Vec<u8>>) {
        let parsed = parse_archive(fixture()).unwrap();
        (
            parsed.password_envelope.to_vec(),
            parsed.records.into_iter().map(<[u8]>::to_vec).collect(),
        )
    }

    #[test]
    fn archived_synthetic_records_authenticate_after_creator_session_is_dropped() {
        let catalog = open_archive(fixture()).unwrap();
        assert_eq!(catalog.len(), RECORD_COUNT);
        for (index, connection_count) in [0, 1, 3].into_iter().enumerate() {
            let entry = catalog.entry(index as u32).unwrap();
            assert!(entry.provider_name() == "Example AI Workshop");
            assert_eq!(entry.connection_count(), connection_count);
        }
        assert_eq!(catalog.entry(0).unwrap().mcp_connection_count(), 0);
        assert_eq!(catalog.entry(1).unwrap().mcp_connection_count(), 1);
        assert_eq!(catalog.entry(2).unwrap().mcp_connection_count(), 1);
    }

    #[test]
    fn archive_contains_envelopes_not_plaintext_display_metadata_or_demo_password() {
        for plaintext in [
            b"Example AI Workshop".as_slice(),
            b"Example Workshop API Credential".as_slice(),
            b"DEMO_VALUE_ONLY_API_KEY_0001".as_slice(),
            DEMO_PASSWORD.as_bytes(),
        ] {
            assert!(
                !fixture()
                    .windows(plaintext.len())
                    .any(|window| window == plaintext),
                "synthetic archive unexpectedly contains plaintext"
            );
        }
    }

    #[test]
    fn truncated_frames_and_trailing_bytes_are_rejected_without_modification() {
        for end in [0, 7, 8, 11, 12, 15, 16, 19, fixture().len() - 1] {
            assert_rejected_unchanged(&fixture()[..end], ArchiveError::InvalidArchive);
        }
        let mut trailing = fixture().to_vec();
        trailing.push(0);
        assert_rejected_unchanged(&trailing, ArchiveError::InvalidArchive);
    }

    #[test]
    fn invalid_magic_version_record_count_and_zero_length_are_rejected() {
        for (offset, replacement) in [(0, 0), (8, 0), (12, 2)] {
            let mut bytes = fixture().to_vec();
            bytes[offset] = replacement;
            assert_rejected_unchanged(&bytes, ArchiveError::InvalidArchive);
        }
        let mut zero_length = fixture().to_vec();
        zero_length[16..20].copy_from_slice(&0_u32.to_le_bytes());
        assert_rejected_unchanged(&zero_length, ArchiveError::InvalidArchive);
    }

    #[test]
    fn future_archive_version_is_preserved_not_reinitialized() {
        let mut future = fixture().to_vec();
        future[8..12].copy_from_slice(&5_u32.to_le_bytes());
        assert_rejected_unchanged(&future, ArchiveError::UpgradeRequired);
    }

    #[test]
    fn archive_and_per_envelope_limits_are_checked_before_payload_read() {
        assert_rejected_unchanged(
            &vec![0; MAX_ARCHIVE_BYTES + 1],
            ArchiveError::LimitsExceeded,
        );
        let mut oversized_envelope = fixture().to_vec();
        oversized_envelope[16..20].copy_from_slice(&65_537_u32.to_le_bytes());
        assert_rejected_unchanged(&oversized_envelope, ArchiveError::LimitsExceeded);
    }

    #[test]
    fn future_password_or_record_envelopes_require_an_upgrade_without_replacement() {
        let (password, mut records) = fixture_parts();
        let future_password = encode_archive(&[0x81, 0x01], &records).unwrap();
        assert_rejected_unchanged(&future_password, ArchiveError::UpgradeRequired);
        records[2] = vec![0x81, 0x01];
        let future_record = encode_archive(&password, &records).unwrap();
        assert_rejected_unchanged(&future_record, ArchiveError::UpgradeRequired);
    }

    #[test]
    fn every_record_shape_is_validated_before_unlocking() {
        let (password, mut records) = fixture_parts();
        records[2] = vec![0];
        let invalid = encode_archive(&password, &records).unwrap();
        let parsed = parse_archive(&invalid).unwrap();
        assert_eq!(
            inspect_envelopes(&parsed),
            Err(ArchiveError::InvalidArchive)
        );
        assert_rejected_unchanged(&invalid, ArchiveError::InvalidArchive);
    }

    #[test]
    fn password_and_last_record_authentication_failures_return_no_partial_catalog() {
        let (mut password, records) = fixture_parts();
        *password.last_mut().unwrap() ^= 1;
        let bad_password = encode_archive(&password, &records).unwrap();
        assert_rejected_unchanged(&bad_password, ArchiveError::AuthenticationFailed);
        let mut bad_last_record = fixture().to_vec();
        *bad_last_record.last_mut().unwrap() ^= 1;
        assert_rejected_unchanged(&bad_last_record, ArchiveError::AuthenticationFailed);
    }

    #[test]
    fn duplicate_authenticated_record_is_rejected_instead_of_silently_deduplicated() {
        let (password, mut records) = fixture_parts();
        records[1] = records[0].clone();
        let duplicate = encode_archive(&password, &records).unwrap();
        assert_rejected_unchanged(&duplicate, ArchiveError::InvalidArchive);
    }

    fn assert_preserved_prefix(previous: &[u8], appended: &[u8]) {
        let old = parse_archive(previous).unwrap();
        let new = parse_archive(appended).unwrap();
        assert!(
            old.password_envelope == new.password_envelope,
            "password ciphertext changed"
        );
        assert_eq!(new.records.len(), old.records.len() + 1);
        for (before, after) in old.records.iter().zip(&new.records) {
            assert!(before == after, "existing record ciphertext changed");
        }
        assert_eq!(u32::from_le_bytes(appended[8..12].try_into().unwrap()), 2);
    }

    #[test]
    fn create_stays_v1_and_append_zero_one_three_connections_emits_v2() {
        assert_eq!(u32::from_le_bytes(fixture()[8..12].try_into().unwrap()), 1);
        let original = fixture().to_vec();
        for connections in [&[][..], &[0][..], &[2, 0, 1][..]] {
            let appended = append_registration(fixture(), 0, 0, connections).unwrap();
            assert_preserved_prefix(fixture(), &appended);
            let catalog = open_archive(&appended).unwrap();
            assert_eq!(catalog.len(), 4);
            let added = catalog.entry(3).unwrap();
            assert!(added.provider_name() == "Example AI Workshop");
            assert_eq!(added.connection_count(), connections.len());
            assert_eq!(added.secret_field_count(), 1);
            for (index, id) in connections.iter().enumerate() {
                let label = match id {
                    0 => "Example MCP",
                    1 => "Example CLI",
                    _ => "Example CI",
                };
                assert!(added.connection(index).unwrap().label() == label);
            }
            assert!(fixture() == original, "successful append mutated input");
        }
    }

    #[test]
    fn repeated_v2_append_preserves_every_prior_envelope_and_authenticates_both_profiles() {
        let first = append_registration(fixture(), 0, 0, &[0]).unwrap();
        let before = first.clone();
        let second = append_registration(&first, 1, 0, &[1, 2]).unwrap();
        assert_preserved_prefix(&first, &second);
        assert!(first == before, "repeated append mutated its input");
        let catalog = open_archive(&second).unwrap();
        assert_eq!(catalog.len(), 5);
        assert!(catalog.entry(3).unwrap().provider_name() == "Example AI Workshop");
        assert!(catalog.entry(4).unwrap().provider_name() == "Example Cloud Lab");
        assert_eq!(catalog.entry(4).unwrap().connection_count(), 2);
        for plaintext in [
            b"DEMO_VALUE_ONLY_API_KEY_0001".as_slice(),
            DEMO_PASSWORD.as_bytes(),
        ] {
            assert!(
                !second
                    .windows(plaintext.len())
                    .any(|window| window == plaintext)
            );
        }
    }

    #[test]
    fn closed_selection_rejections_leave_original_ciphertext_unchanged() {
        let original = fixture().to_vec();
        for (profile, credential, connections, expected) in [
            (2, 0, &[][..], ArchiveError::InvalidArchive),
            (u32::MAX, 0, &[][..], ArchiveError::InvalidArchive),
            (0, 1, &[][..], ArchiveError::InvalidArchive),
            (0, u32::MAX, &[][..], ArchiveError::InvalidArchive),
            (0, 0, &[3][..], ArchiveError::InvalidArchive),
            (0, 0, &[0, 0][..], ArchiveError::InvalidArchive),
            (0, 0, &[0, 1, 2, 0][..], ArchiveError::LimitsExceeded),
        ] {
            assert_eq!(
                append_registration(fixture(), profile, credential, connections).err(),
                Some(expected)
            );
            assert!(
                fixture() == original,
                "invalid selection changed ciphertext"
            );
        }
    }

    #[test]
    fn v1_count_is_exact_and_v2_count_is_bounded_before_envelope_read() {
        for count in [0, 2, 4, 128, 129, u32::MAX] {
            let mut v1 = fixture().to_vec();
            v1[12..16].copy_from_slice(&count.to_le_bytes());
            assert_rejected_unchanged(&v1, ArchiveError::InvalidArchive);
        }
        for (count, expected) in [
            (0_u32, ArchiveError::InvalidArchive),
            (2, ArchiveError::InvalidArchive),
            (129, ArchiveError::LimitsExceeded),
            (u32::MAX, ArchiveError::LimitsExceeded),
        ] {
            let mut v2 = fixture().to_vec();
            v2[8..12].copy_from_slice(&MUTABLE_ARCHIVE_VERSION.to_le_bytes());
            v2[12..16].copy_from_slice(&count.to_le_bytes());
            assert_rejected_unchanged(&v2, expected);
        }
        let mut minimum = fixture().to_vec();
        minimum[8..12].copy_from_slice(&MUTABLE_ARCHIVE_VERSION.to_le_bytes());
        assert_eq!(open_archive(&minimum).unwrap().len(), RECORD_COUNT);
    }

    #[test]
    fn v2_encoding_keeps_archive_and_envelope_size_caps() {
        let oversized = vec![0; MAX_ENVELOPE_BYTES + 1];
        assert_eq!(
            encode_archive_version(2, &[1], &[&[1], &[1], &oversized]).err(),
            Some(ArchiveError::LimitsExceeded)
        );
        let maximum = vec![0; MAX_ENVELOPE_BYTES];
        let records = vec![maximum.as_slice(); 8];
        assert_eq!(
            encode_archive_version(2, &[1], &records).err(),
            Some(ArchiveError::LimitsExceeded)
        );
    }

    #[test]
    fn v2_last_record_is_authenticated_and_duplicate_existing_ids_are_rejected_before_append() {
        let appended = append_registration(fixture(), 0, 0, &[]).unwrap();
        let mut corrupt = appended.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        assert_rejected_unchanged(&corrupt, ArchiveError::AuthenticationFailed);
        let parsed = parse_archive(&appended).unwrap();
        let mut records = parsed.records;
        records[3] = records[0];
        let duplicate = encode_archive_version(2, parsed.password_envelope, &records).unwrap();
        assert_rejected_unchanged(&duplicate, ArchiveError::InvalidArchive);
        records[3] = &[0x81, 0x01];
        let future = encode_archive_version(2, parsed.password_envelope, &records).unwrap();
        assert_rejected_unchanged(&future, ArchiveError::UpgradeRequired);
    }

    #[test]
    fn append_reaches_128_records_but_never_exceeds_it() {
        let parsed = parse_archive(fixture()).unwrap();
        let session =
            unlock_vault_v0alpha1(&demo_password().unwrap(), parsed.password_envelope).unwrap();
        let selection = SyntheticRegistrationSelectionV1::from_ids(0, 0, &[]).unwrap();
        let mut records: Vec<Vec<u8>> = parsed.records.iter().map(|bytes| bytes.to_vec()).collect();
        while records.len() < MAX_RECORD_COUNT - 1 {
            let sealed = seal_synthetic_registration_v1(&session, &selection).unwrap();
            records.push(sealed.persistence_projection_v1().envelope().to_vec());
        }
        let record_refs: Vec<&[u8]> = records.iter().map(Vec::as_slice).collect();
        let before = encode_archive_version(2, parsed.password_envelope, &record_refs).unwrap();
        let maximum = append_registration(&before, 1, 0, &[0]).unwrap();
        assert_preserved_prefix(&before, &maximum);
        assert_eq!(open_archive(&maximum).unwrap().len(), MAX_RECORD_COUNT);
        let saved = maximum.clone();
        assert_eq!(
            append_registration(&maximum, 0, 0, &[]).err(),
            Some(ArchiveError::LimitsExceeded)
        );
        assert!(maximum == saved, "limit rejection changed archive");
    }
}
