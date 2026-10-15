use crate::WasmCatalogV1;
use crate::archive;
use vault_local_core::SyntheticVerificationEvidenceV1;
use wasm_bindgen::prelude::*;

#[path = "demo_staging.rs"]
mod staging;
pub use staging::{
    WasmRotationStageV1, create_synthetic_rotation_cutover_from_stage,
    create_synthetic_rotation_stage, inspect_synthetic_rotation_stage,
};

/// Getter-only projection of one authenticated synthetic rotation checklist.
/// It exposes fixed classifications and counts only. Direct JavaScript
/// construction is rejected, so usable instances come only from inspection.
#[wasm_bindgen]
pub struct WasmRotationChecklistV1 {
    checklist: Option<archive::ArchiveRotationChecklistV1>,
}

impl WasmRotationChecklistV1 {
    fn from_checklist(checklist: archive::ArchiveRotationChecklistV1) -> Self {
        Self {
            checklist: Some(checklist),
        }
    }

    fn unlocked(&self) -> Result<&archive::ArchiveRotationChecklistV1, JsValue> {
        self.checklist
            .as_ref()
            .ok_or_else(|| JsValue::from_str("LOCKED"))
    }

    fn entry_index(&self, index: &JsValue) -> Result<usize, JsValue> {
        let checklist = self.unlocked()?;
        let index = strict_u32(index).map_err(|_| JsValue::from_str("INVALID_REFERENCE"))?;
        let index = usize::try_from(index).map_err(|_| JsValue::from_str("INVALID_REFERENCE"))?;
        checklist
            .entries()
            .get(index)
            .map(|_| index)
            .ok_or_else(|| JsValue::from_str("INVALID_REFERENCE"))
    }
}

#[wasm_bindgen]
impl WasmRotationChecklistV1 {
    /// wasm-bindgen classes otherwise receive an implicit JavaScript default
    /// constructor. Reject it so only authenticated archive inspection can
    /// create a usable checklist instance.
    #[wasm_bindgen(constructor)]
    pub fn reject_direct_construction() -> WasmRotationChecklistV1 {
        wasm_bindgen::throw_str("CONSTRUCTOR_DISABLED")
    }

    #[wasm_bindgen(js_name = isLocked)]
    pub fn is_locked(&self) -> bool {
        self.checklist.is_none()
    }

    /// Idempotently drops the authenticated checklist projection. Existing JS
    /// scalar copies cannot be revoked, so the host must clear its own state.
    pub fn lock(&mut self) {
        self.checklist.take();
    }

    pub fn generation(&self) -> Result<String, JsValue> {
        Ok(generation_name(self.unlocked()?.generation()).to_owned())
    }

    #[wasm_bindgen(js_name = readinessState)]
    pub fn readiness_state(&self) -> Result<String, JsValue> {
        Ok(readiness_name(self.unlocked()?.readiness_state()).to_owned())
    }

    #[wasm_bindgen(js_name = entryCount)]
    pub fn entry_count(&self) -> Result<u32, JsValue> {
        u32::try_from(self.unlocked()?.entries().len())
            .map_err(|_| JsValue::from_str("LIMITS_EXCEEDED"))
    }

    #[wasm_bindgen(js_name = entryFixture)]
    pub fn entry_fixture(&self, index: JsValue) -> Result<String, JsValue> {
        let index = self.entry_index(&index)?;
        Ok(fixture_name(self.unlocked()?.entries()[index].fixture()).to_owned())
    }

    #[wasm_bindgen(js_name = entryRequiredForCutover)]
    pub fn entry_required_for_cutover(&self, index: JsValue) -> Result<bool, JsValue> {
        let index = self.entry_index(&index)?;
        Ok(self.unlocked()?.entries()[index].required_for_cutover())
    }

    #[wasm_bindgen(js_name = remainingRequired)]
    pub fn remaining_required(&self) -> Result<u32, JsValue> {
        Ok(self.unlocked()?.remaining_required())
    }

    #[wasm_bindgen(js_name = remainingOptional)]
    pub fn remaining_optional(&self) -> Result<u32, JsValue> {
        Ok(self.unlocked()?.remaining_optional())
    }
}

/// Exercise real Rust encryption and authenticated projection with fixed
/// synthetic fixtures. Run in a Worker: Argon2 is intentionally expensive.
/// No arguments: this export cannot import arbitrary user credentials.
/// This function does not exist in default (non-demo) builds.
#[wasm_bindgen(js_name = syntheticCatalog)]
pub fn synthetic_catalog() -> Result<WasmCatalogV1, JsValue> {
    let snapshot = archive::create_catalog().map_err(archive_js_error)?;
    // Session/root key and fixture secret data drop before returning to JS.
    Ok(WasmCatalogV1::from_snapshot(snapshot))
}

/// Create encrypted transport bytes for three fixed fixtures only. The public
/// DEMO password is not real protection; this is not a real-secret input API.
#[wasm_bindgen(js_name = createSyntheticArchive)]
pub fn create_synthetic_archive() -> Result<Vec<u8>, JsValue> {
    archive::create_archive().map_err(archive_js_error)
}

/// Authenticate a bounded demo archive into an unlocked, allowlisted catalog.
/// This does not write storage or establish origin, completeness or freshness.
/// Hosts must preserve rejected bytes, clear rows on lock and never log them.
#[wasm_bindgen(js_name = openSyntheticArchive)]
pub fn open_synthetic_archive(bytes: &[u8]) -> Result<WasmCatalogV1, JsValue> {
    archive::open_archive(bytes)
        .map(WasmCatalogV1::from_snapshot)
        .map_err(archive_js_error)
}

/// Append only a closed Rust-owned synthetic profile/credential/connection set.
/// f64 preserves JS numeric values until validated, avoiding u32 coercion aliases.
/// Returns a v2/v3 ciphertext archive; no key, plaintext credential or storage write.
#[wasm_bindgen(js_name = appendSyntheticRegistration)]
pub fn append_synthetic_registration(
    bytes: &[u8],
    profile_id: f64,
    credential_id: f64,
    connection_ids: &[f64],
) -> Result<Vec<u8>, JsValue> {
    if connection_ids.len() > 3 {
        return Err(archive_js_error(archive::ArchiveError::LimitsExceeded));
    }
    let profile_id = selection_id(profile_id).map_err(archive_js_error)?;
    let credential_id = selection_id(credential_id).map_err(archive_js_error)?;
    let connection_ids = connection_ids
        .iter()
        .copied()
        .map(selection_id)
        .collect::<Result<Vec<_>, _>>()
        .map_err(archive_js_error)?;
    archive::append_registration(bytes, profile_id, credential_id, &connection_ids)
        .map_err(archive_js_error)
}

/// Change only closed synthetic connections in the selected archive snapshot.
/// The host must bind reference to these exact displayed bytes and use them as
/// the storage CAS expected value. Returns v3 ciphertext, never writes storage.
#[wasm_bindgen(js_name = editSyntheticConnections)]
pub fn edit_synthetic_connections(
    bytes: &[u8],
    reference: f64,
    connection_ids: &[f64],
) -> Result<Vec<u8>, JsValue> {
    if connection_ids.len() > 3 {
        return Err(archive_js_error(archive::ArchiveError::LimitsExceeded));
    }
    let reference = selection_id(reference).map_err(archive_js_error)?;
    let connection_ids = connection_ids
        .iter()
        .copied()
        .map(selection_id)
        .collect::<Result<Vec<_>, _>>()
        .map_err(archive_js_error)?;
    archive::edit_connections(bytes, reference, &connection_ids).map_err(archive_js_error)
}

/// Authenticate one exact archive reference and return a fixed-output rotation
/// checklist. Completion flags must be primitive JavaScript booleans. The
/// revocation evidence must be the primitive JavaScript number 0 (user
/// confirmed) or 1 (provider verified); no strings or truthy values coerce.
#[wasm_bindgen(js_name = inspectSyntheticRotationChecklist)]
#[allow(clippy::too_many_arguments)]
pub fn inspect_synthetic_rotation_checklist(
    bytes: &[u8],
    reference: JsValue,
    mcp_user_confirmed: JsValue,
    cli_user_confirmed: JsValue,
    ci_user_confirmed: JsValue,
    mcp_provider_verified: JsValue,
    cli_provider_verified: JsValue,
    ci_provider_verified: JsValue,
    superseded_revocation: JsValue,
) -> Result<WasmRotationChecklistV1, JsValue> {
    let reference = strict_u32(&reference).map_err(archive_js_error)?;
    let (user_confirmed, provider_verified) = strict_rotation_completion(
        [&mcp_user_confirmed, &cli_user_confirmed, &ci_user_confirmed],
        [
            &mcp_provider_verified,
            &cli_provider_verified,
            &ci_provider_verified,
        ],
    )
    .map_err(archive_js_error)?;
    let superseded_revocation =
        strict_rotation_evidence(&superseded_revocation).map_err(archive_js_error)?;
    archive::inspect_rotation_checklist(
        bytes,
        reference,
        &user_confirmed,
        &provider_verified,
        superseded_revocation,
    )
    .map(WasmRotationChecklistV1::from_checklist)
    .map_err(archive_js_error)
}

/// Create one encrypted synthetic cutover candidate. This never writes host
/// storage and accepts no arbitrary secret, text, identifier or provider data.
#[wasm_bindgen(js_name = createSyntheticRotationCutover)]
#[allow(clippy::too_many_arguments)]
pub fn create_synthetic_rotation_cutover(
    bytes: &[u8],
    reference: JsValue,
    mcp_user_confirmed: JsValue,
    cli_user_confirmed: JsValue,
    ci_user_confirmed: JsValue,
    mcp_provider_verified: JsValue,
    cli_provider_verified: JsValue,
    ci_provider_verified: JsValue,
    superseded_revocation: JsValue,
) -> Result<Vec<u8>, JsValue> {
    let reference = strict_u32(&reference).map_err(archive_js_error)?;
    let (user_confirmed, provider_verified) = strict_rotation_completion(
        [&mcp_user_confirmed, &cli_user_confirmed, &ci_user_confirmed],
        [
            &mcp_provider_verified,
            &cli_provider_verified,
            &ci_provider_verified,
        ],
    )
    .map_err(archive_js_error)?;
    let superseded_revocation =
        strict_rotation_evidence(&superseded_revocation).map_err(archive_js_error)?;
    archive::create_rotation_cutover_candidate(
        bytes,
        reference,
        &user_confirmed,
        &provider_verified,
        superseded_revocation,
    )
    .map_err(archive_js_error)
}

fn strict_u32(value: &JsValue) -> Result<u32, archive::ArchiveError> {
    let value = value
        .as_f64()
        .ok_or(archive::ArchiveError::InvalidArchive)?;
    if !value.is_finite()
        || value < 0.0
        || (value == 0.0 && value.is_sign_negative())
        || value.fract() != 0.0
        || value > f64::from(u32::MAX)
    {
        return Err(archive::ArchiveError::InvalidArchive);
    }
    Ok(value as u32)
}

fn strict_rotation_completion(
    user_confirmed: [&JsValue; 3],
    provider_verified: [&JsValue; 3],
) -> Result<(Vec<u32>, Vec<u32>), archive::ArchiveError> {
    let mut user_ids = Vec::with_capacity(3);
    let mut provider_ids = Vec::with_capacity(3);
    for (fixture_id, (user, provider)) in user_confirmed
        .into_iter()
        .zip(provider_verified)
        .enumerate()
    {
        let user = user
            .as_bool()
            .ok_or(archive::ArchiveError::InvalidArchive)?;
        let provider = provider
            .as_bool()
            .ok_or(archive::ArchiveError::InvalidArchive)?;
        let fixture_id =
            u32::try_from(fixture_id).map_err(|_| archive::ArchiveError::LimitsExceeded)?;
        if user {
            user_ids.push(fixture_id);
        }
        if provider {
            provider_ids.push(fixture_id);
        }
    }
    Ok((user_ids, provider_ids))
}

fn strict_rotation_evidence(
    value: &JsValue,
) -> Result<SyntheticVerificationEvidenceV1, archive::ArchiveError> {
    match value.as_f64() {
        Some(value) if value == 0.0 && value.is_sign_positive() => {
            Ok(SyntheticVerificationEvidenceV1::UserConfirmed)
        }
        Some(1.0) => Ok(SyntheticVerificationEvidenceV1::ProviderVerified),
        _ => Err(archive::ArchiveError::InvalidArchive),
    }
}

const fn generation_name(generation: archive::ArchiveRotationGenerationV1) -> &'static str {
    match generation {
        archive::ArchiveRotationGenerationV1::Initial0001 => "initial_0001",
        archive::ArchiveRotationGenerationV1::Rotated0002 => "rotated_0002",
        archive::ArchiveRotationGenerationV1::Terminal0003 => "terminal_0003",
    }
}

const fn readiness_name(state: archive::ArchiveRotationReadinessStateV1) -> &'static str {
    match state {
        archive::ArchiveRotationReadinessStateV1::RequiredPending => "required_pending",
        archive::ArchiveRotationReadinessStateV1::Ready => "ready",
        archive::ArchiveRotationReadinessStateV1::Terminal => "terminal",
    }
}

const fn fixture_name(fixture: archive::ArchiveRotationFixtureV1) -> &'static str {
    match fixture {
        archive::ArchiveRotationFixtureV1::Mcp => "mcp",
        archive::ArchiveRotationFixtureV1::Cli => "cli",
        archive::ArchiveRotationFixtureV1::Ci => "ci",
    }
}

fn selection_id(value: f64) -> Result<u32, archive::ArchiveError> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > f64::from(u32::MAX) {
        return Err(archive::ArchiveError::InvalidArchive);
    }
    Ok(value as u32)
}

fn archive_js_error(error: archive::ArchiveError) -> JsValue {
    JsValue::from_str(error.code())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_selection_numbers_do_not_wrap_truncate_or_accept_non_finite_values() {
        for invalid in [
            -1.0,
            0.5,
            4_294_967_296.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            assert_eq!(
                selection_id(invalid),
                Err(archive::ArchiveError::InvalidArchive)
            );
        }
        assert_eq!(selection_id(0.0), Ok(0));
        assert_eq!(selection_id(f64::from(u32::MAX)), Ok(u32::MAX));
    }

    #[test]
    fn rotation_fixed_names_cover_every_closed_variant() {
        assert_eq!(
            generation_name(archive::ArchiveRotationGenerationV1::Initial0001),
            "initial_0001"
        );
        assert_eq!(
            generation_name(archive::ArchiveRotationGenerationV1::Rotated0002),
            "rotated_0002"
        );
        assert_eq!(
            generation_name(archive::ArchiveRotationGenerationV1::Terminal0003),
            "terminal_0003"
        );
        assert_eq!(
            readiness_name(archive::ArchiveRotationReadinessStateV1::RequiredPending),
            "required_pending"
        );
        assert_eq!(
            readiness_name(archive::ArchiveRotationReadinessStateV1::Ready),
            "ready"
        );
        assert_eq!(
            readiness_name(archive::ArchiveRotationReadinessStateV1::Terminal),
            "terminal"
        );
        assert_eq!(fixture_name(archive::ArchiveRotationFixtureV1::Mcp), "mcp");
        assert_eq!(fixture_name(archive::ArchiveRotationFixtureV1::Cli), "cli");
        assert_eq!(fixture_name(archive::ArchiveRotationFixtureV1::Ci), "ci");
    }

    #[test]
    fn rotation_checklist_projection_locks_without_exposing_extra_fields() {
        let bytes = archive::create_archive().unwrap();
        let checklist = archive::inspect_rotation_checklist(
            &bytes,
            2,
            &[],
            &[],
            SyntheticVerificationEvidenceV1::UserConfirmed,
        )
        .unwrap();
        let mut checklist = WasmRotationChecklistV1::from_checklist(checklist);
        assert_eq!(checklist.generation().unwrap(), "initial_0001");
        assert_eq!(checklist.readiness_state().unwrap(), "ready");
        assert_eq!(checklist.entry_count().unwrap(), 3);
        assert_eq!(checklist.remaining_required().unwrap(), 0);
        assert_eq!(checklist.remaining_optional().unwrap(), 3);
        assert!(!checklist.is_locked());
        checklist.lock();
        checklist.lock();
        assert!(checklist.is_locked());
        // Exact thrown LOCKED values are covered by the real-WASM script;
        // constructing JsValue errors is unsupported in native Rust tests.
    }
}
