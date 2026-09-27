//! Demo-only saved progress projection; never a canonical credential or Secret API.
use super::{archive_js_error, strict_rotation_completion, strict_u32};
use crate::archive;
use vault_local_core::{
    SyntheticRotationChecklistFixtureV1, SyntheticRotationChecklistGenerationV1,
    SyntheticRotationStageCompletionV1, SyntheticRotationStageProjectionV1,
    SyntheticRotationStageRevocationV1,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmRotationStageV1 {
    stage: Option<SyntheticRotationStageProjectionV1>,
}

impl WasmRotationStageV1 {
    fn from_stage(stage: SyntheticRotationStageProjectionV1) -> Self {
        Self { stage: Some(stage) }
    }

    fn unlocked(&self) -> Result<&SyntheticRotationStageProjectionV1, JsValue> {
        self.stage
            .as_ref()
            .ok_or_else(|| JsValue::from_str("LOCKED"))
    }

    fn entry(
        &self,
        index: JsValue,
    ) -> Result<&vault_local_core::SyntheticRotationStageEntryV1, JsValue> {
        let stage = self.unlocked()?;
        let index = strict_u32(&index).map_err(|_| JsValue::from_str("INVALID_REFERENCE"))?;
        let index = usize::try_from(index).map_err(|_| JsValue::from_str("INVALID_REFERENCE"))?;
        stage
            .entries()
            .get(index)
            .ok_or_else(|| JsValue::from_str("INVALID_REFERENCE"))
    }
}

#[wasm_bindgen]
impl WasmRotationStageV1 {
    #[wasm_bindgen(constructor)]
    pub fn reject_direct_construction() -> WasmRotationStageV1 {
        wasm_bindgen::throw_str("CONSTRUCTOR_DISABLED")
    }

    #[wasm_bindgen(js_name = isLocked)]
    pub fn is_locked(&self) -> bool {
        self.stage.is_none()
    }

    pub fn lock(&mut self) {
        self.stage.take();
    }

    #[wasm_bindgen(js_name = baseGeneration)]
    pub fn base_generation(&self) -> Result<String, JsValue> {
        Ok(generation_name(self.unlocked()?.base_generation()).to_owned())
    }

    #[wasm_bindgen(js_name = targetGeneration)]
    pub fn target_generation(&self) -> Result<String, JsValue> {
        Ok(generation_name(self.unlocked()?.target_generation()).to_owned())
    }

    #[wasm_bindgen(js_name = entryCount)]
    pub fn entry_count(&self) -> Result<u32, JsValue> {
        u32::try_from(self.unlocked()?.entries().len())
            .map_err(|_| JsValue::from_str("LIMITS_EXCEEDED"))
    }

    #[wasm_bindgen(js_name = entryFixture)]
    pub fn entry_fixture(&self, index: JsValue) -> Result<String, JsValue> {
        Ok(match self.entry(index)?.fixture() {
            SyntheticRotationChecklistFixtureV1::Mcp => "mcp",
            SyntheticRotationChecklistFixtureV1::Cli => "cli",
            SyntheticRotationChecklistFixtureV1::Ci => "ci",
        }
        .to_owned())
    }

    #[wasm_bindgen(js_name = entryRequiredForCutover)]
    pub fn entry_required_for_cutover(&self, index: JsValue) -> Result<bool, JsValue> {
        Ok(self.entry(index)?.required_for_cutover())
    }

    #[wasm_bindgen(js_name = entryCompletion)]
    pub fn entry_completion(&self, index: JsValue) -> Result<String, JsValue> {
        Ok(match self.entry(index)?.completion() {
            SyntheticRotationStageCompletionV1::Pending => "pending",
            SyntheticRotationStageCompletionV1::UserConfirmed => "user_confirmed",
            SyntheticRotationStageCompletionV1::ProviderVerified => "provider_verified",
        }
        .to_owned())
    }

    pub fn revocation(&self) -> Result<String, JsValue> {
        Ok(match self.unlocked()?.revocation() {
            SyntheticRotationStageRevocationV1::Pending => "pending",
            SyntheticRotationStageRevocationV1::UserConfirmed => "user_confirmed",
            SyntheticRotationStageRevocationV1::ProviderVerified => "provider_verified",
        }
        .to_owned())
    }

    #[wasm_bindgen(js_name = remainingRequired)]
    pub fn remaining_required(&self) -> Result<u32, JsValue> {
        Ok(self.unlocked()?.remaining_required())
    }

    #[wasm_bindgen(js_name = remainingOptional)]
    pub fn remaining_optional(&self) -> Result<u32, JsValue> {
        Ok(self.unlocked()?.remaining_optional())
    }

    #[wasm_bindgen(js_name = readyForCutover)]
    pub fn ready_for_cutover(&self) -> Result<bool, JsValue> {
        Ok(self.unlocked()?.ready_for_cutover())
    }
}

/// None means no saved stage for this exact current head, never an auth failure.
#[wasm_bindgen(js_name = inspectSyntheticRotationStage)]
pub fn inspect_synthetic_rotation_stage(
    bytes: &[u8],
    reference: JsValue,
) -> Result<Option<WasmRotationStageV1>, JsValue> {
    let reference = strict_u32(&reference).map_err(archive_js_error)?;
    archive::inspect_rotation_stage(bytes, reference)
        .map(|stage| stage.map(WasmRotationStageV1::from_stage))
        .map_err(archive_js_error)
}

/// Explicit encrypted progress save candidate. Code 0 is pending revocation;
/// 1/2 are simulated user/provider confirmation, not provider API evidence.
#[wasm_bindgen(js_name = createSyntheticRotationStage)]
#[allow(clippy::too_many_arguments)]
pub fn create_synthetic_rotation_stage(
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
    let revocation = match strict_u32(&superseded_revocation).map_err(archive_js_error)? {
        0 => SyntheticRotationStageRevocationV1::Pending,
        1 => SyntheticRotationStageRevocationV1::UserConfirmed,
        2 => SyntheticRotationStageRevocationV1::ProviderVerified,
        _ => return Err(archive_js_error(archive::ArchiveError::InvalidArchive)),
    };
    archive::create_rotation_stage_candidate(
        bytes,
        reference,
        &user_confirmed,
        &provider_verified,
        revocation,
    )
    .map_err(archive_js_error)
}

#[wasm_bindgen(js_name = createSyntheticRotationCutoverFromStage)]
pub fn create_synthetic_rotation_cutover_from_stage(
    bytes: &[u8],
    reference: JsValue,
) -> Result<Vec<u8>, JsValue> {
    let reference = strict_u32(&reference).map_err(archive_js_error)?;
    archive::create_rotation_cutover_from_stage_candidate(bytes, reference)
        .map_err(archive_js_error)
}

const fn generation_name(generation: SyntheticRotationChecklistGenerationV1) -> &'static str {
    match generation {
        SyntheticRotationChecklistGenerationV1::Initial0001 => "initial_0001",
        SyntheticRotationChecklistGenerationV1::Rotated0002 => "rotated_0002",
        SyntheticRotationChecklistGenerationV1::Terminal0003 => "terminal_0003",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_progress_projection_locks_without_retaining_stage_envelope() {
        let bytes = archive::create_archive().unwrap();
        let bytes = archive::create_rotation_stage_candidate(
            &bytes,
            2,
            &[0],
            &[],
            SyntheticRotationStageRevocationV1::Pending,
        )
        .unwrap();
        let stage = archive::inspect_rotation_stage(&bytes, 2).unwrap().unwrap();
        let mut handle = WasmRotationStageV1::from_stage(stage);
        assert_eq!(handle.base_generation().unwrap(), "initial_0001");
        assert_eq!(handle.target_generation().unwrap(), "rotated_0002");
        assert_eq!(handle.revocation().unwrap(), "pending");
        assert_eq!(handle.entry_count().unwrap(), 3);
        assert_eq!(handle.remaining_required().unwrap(), 0);
        assert_eq!(handle.remaining_optional().unwrap(), 2);
        assert!(!handle.ready_for_cutover().unwrap());
        assert!(!handle.is_locked());
        handle.lock();
        handle.lock();
        assert!(handle.is_locked());
    }
}
