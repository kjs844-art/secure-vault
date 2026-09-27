//! Authenticated, sanitized checklist projection for synthetic rotation.
//!
//! This boundary returns only closed fixture classifications and the cutover
//! requirement bit. It exposes no Secret, arbitrary text, time, entity or
//! revision identifier, URL, provider proof, or mutation authority.

use vault_crypto::VaultSession;

use crate::LocalVaultError;
use crate::connection_edit::ConnectionProfile;
use crate::model::ConnectionStatusV1;
use crate::persistence::inspect_synthetic_predecessor_v1;
use crate::record::SealedCredentialRecordV0Alpha1;
use crate::registration::ConnectionFixture;
use crate::rotation::{SyntheticApiKeyGeneration, classify_synthetic_generation_v1};

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SyntheticRotationChecklistGenerationV1 {
    Initial0001,
    Rotated0002,
    Terminal0003,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SyntheticRotationChecklistFixtureV1 {
    Mcp,
    Cli,
    Ci,
}

/// One sanitized, non-removed connection in authenticated payload order.
pub struct SyntheticRotationChecklistEntryV1 {
    fixture: SyntheticRotationChecklistFixtureV1,
    required_for_cutover: bool,
}

impl SyntheticRotationChecklistEntryV1 {
    pub const fn fixture(&self) -> SyntheticRotationChecklistFixtureV1 {
        self.fixture
    }

    pub const fn required_for_cutover(&self) -> bool {
        self.required_for_cutover
    }
}

/// Getter-only projection. Terminal generation remains inspectable even though
/// the closed synthetic fixture cannot rotate again.
pub struct SyntheticRotationChecklistV1 {
    generation: SyntheticRotationChecklistGenerationV1,
    entries: Vec<SyntheticRotationChecklistEntryV1>,
}

impl SyntheticRotationChecklistV1 {
    pub const fn generation(&self) -> SyntheticRotationChecklistGenerationV1 {
        self.generation
    }

    pub fn entries(&self) -> &[SyntheticRotationChecklistEntryV1] {
        &self.entries
    }
}

/// Authenticates `head` from its canonical envelope, validates the existing
/// rotation lifecycle, and returns a closed, display-safe checklist.
///
/// This validates only the caller-supplied authenticated record and lifecycle
/// evidence embedded in that revision. It does not establish that `head` is
/// the latest durable revision, authenticate an ancestor chain, or detect a
/// valid older revision being replayed or supplied after rollback.
///
/// A mutated cached locator cannot redirect inspection. Every connection,
/// including removed connections, must have an unambiguous known synthetic
/// structure. Removed connections are then omitted from the projection.
pub fn inspect_synthetic_rotation_checklist_v1(
    session: &VaultSession,
    head: &SealedCredentialRecordV0Alpha1,
) -> Result<SyntheticRotationChecklistV1, LocalVaultError> {
    inspect_synthetic_predecessor_v1(session, head, |item, _| {
        let profile = ConnectionProfile::from_item(item)?;
        let generation = match classify_synthetic_generation_v1(item)? {
            SyntheticApiKeyGeneration::Initial0001 => {
                SyntheticRotationChecklistGenerationV1::Initial0001
            }
            SyntheticApiKeyGeneration::Rotated0002 => {
                SyntheticRotationChecklistGenerationV1::Rotated0002
            }
            SyntheticApiKeyGeneration::Rotated0003 => {
                SyntheticRotationChecklistGenerationV1::Terminal0003
            }
        };

        let mut seen = 0_u8;
        let mut entries = Vec::with_capacity(item.connections.len().min(3));
        for connection in &item.connections {
            let fixture = profile.classify(connection)?;
            let bit = fixture_bit(fixture);
            if seen & bit != 0 {
                return Err(LocalVaultError::InvalidItem);
            }
            seen |= bit;

            match connection.status {
                ConnectionStatusV1::Connected
                | ConnectionStatusV1::UpdateRequired
                | ConnectionStatusV1::Verified => {}
                ConnectionStatusV1::Removed => continue,
                ConnectionStatusV1::Unknown => return Err(LocalVaultError::InvalidItem),
            }

            entries.push(SyntheticRotationChecklistEntryV1 {
                fixture: project_fixture(fixture),
                required_for_cutover: connection.required_for_cutover,
            });
        }

        Ok(SyntheticRotationChecklistV1 {
            generation,
            entries,
        })
    })
}

const fn fixture_bit(fixture: ConnectionFixture) -> u8 {
    match fixture {
        ConnectionFixture::Mcp => 1,
        ConnectionFixture::Cli => 2,
        ConnectionFixture::Ci => 4,
    }
}

const fn project_fixture(fixture: ConnectionFixture) -> SyntheticRotationChecklistFixtureV1 {
    match fixture {
        ConnectionFixture::Mcp => SyntheticRotationChecklistFixtureV1::Mcp,
        ConnectionFixture::Cli => SyntheticRotationChecklistFixtureV1::Cli,
        ConnectionFixture::Ci => SyntheticRotationChecklistFixtureV1::Ci,
    }
}

#[cfg(test)]
#[path = "rotation_checklist_tests.rs"]
mod tests;
