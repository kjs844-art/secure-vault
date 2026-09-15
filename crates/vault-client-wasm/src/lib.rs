//! Local, private-metadata display boundary. No network or real-secret input API.
//! Only the synthetic-demo feature exposes encrypted test-archive input/output.
//! Real-secret support remains gated. JavaScript string copies cannot be wiped
//! by Rust; hosts must clear state/DOM on lock and must not persist or log rows.

#![forbid(unsafe_code)]

use vault_client_bridge::{
    CatalogConnectionTypeV1, CatalogCredentialStatusV1, CatalogCredentialTypeV1,
    ClientCatalogEntryViewV1, ClientCatalogSnapshotV1,
};
use wasm_bindgen::prelude::*;

#[cfg(feature = "synthetic-demo")]
mod archive;
#[cfg(feature = "synthetic-demo")]
mod demo;
#[cfg(feature = "synthetic-demo")]
pub use demo::{
    append_synthetic_registration, create_synthetic_archive, open_synthetic_archive,
    synthetic_catalog,
};

/// Owns one catalog. Every getter checks this object's lock state.
/// References are local to this object and never authorize secret operations.
#[wasm_bindgen]
pub struct WasmCatalogV1 {
    snapshot: Option<ClientCatalogSnapshotV1>,
}

impl WasmCatalogV1 {
    /// Rust-only construction. Not exported as a JavaScript constructor.
    pub fn from_snapshot(snapshot: ClientCatalogSnapshotV1) -> Self {
        Self {
            snapshot: Some(snapshot),
        }
    }

    fn unlocked(&self) -> Result<&ClientCatalogSnapshotV1, JsValue> {
        self.snapshot
            .as_ref()
            .ok_or_else(|| JsValue::from_str("LOCKED"))
    }

    fn entry(&self, reference: f64) -> Result<ClientCatalogEntryViewV1<'_>, JsValue> {
        let snapshot = self.unlocked()?;
        // wasm-bindgen coerces JS numbers passed as u32; validate the original
        // f64 first so 2^32, negatives, fractions and NaN cannot alias row zero.
        if !reference.is_finite()
            || reference < 0.0
            || reference.fract() != 0.0
            || reference > f64::from(u32::MAX)
        {
            return Err(JsValue::from_str("INVALID_REFERENCE"));
        }
        snapshot
            .entry(reference as u32)
            .ok_or_else(|| JsValue::from_str("INVALID_REFERENCE"))
    }
}

#[wasm_bindgen]
impl WasmCatalogV1 {
    pub fn length(&self) -> Result<u32, JsValue> {
        u32::try_from(self.unlocked()?.len()).map_err(|_| JsValue::from_str("LIMITS_EXCEEDED"))
    }

    #[wasm_bindgen(js_name = isLocked)]
    pub fn is_locked(&self) -> bool {
        self.snapshot.is_none()
    }

    /// Idempotently drop/zeroize the Rust catalog. Existing JS copies must be
    /// discarded by the host; they cannot be revoked or reliably zeroized here.
    pub fn lock(&mut self) {
        self.snapshot.take();
    }

    #[wasm_bindgen(js_name = itemName)]
    pub fn item_name(&self, reference: f64) -> Result<JsValue, JsValue> {
        Ok(JsValue::from_str(self.entry(reference)?.item_name()))
    }

    #[wasm_bindgen(js_name = providerName)]
    pub fn provider_name(&self, reference: f64) -> Result<JsValue, JsValue> {
        Ok(JsValue::from_str(self.entry(reference)?.provider_name()))
    }

    /// Optional private local metadata; absent source values become JS undefined.
    #[wasm_bindgen(js_name = issuerAccountIdentifier)]
    pub fn issuer_account_identifier(&self, reference: f64) -> Result<Option<String>, JsValue> {
        Ok(self
            .entry(reference)?
            .issuer_account_identifier()
            .map(str::to_owned))
    }

    #[wasm_bindgen(js_name = issuerOrganizationOrWorkspace)]
    pub fn issuer_organization_or_workspace(
        &self,
        reference: f64,
    ) -> Result<Option<String>, JsValue> {
        Ok(self
            .entry(reference)?
            .issuer_organization_or_workspace()
            .map(str::to_owned))
    }

    #[wasm_bindgen(js_name = issuerProject)]
    pub fn issuer_project(&self, reference: f64) -> Result<Option<String>, JsValue> {
        Ok(self.entry(reference)?.issuer_project().map(str::to_owned))
    }

    #[wasm_bindgen(js_name = issuerEnvironment)]
    pub fn issuer_environment(&self, reference: f64) -> Result<Option<String>, JsValue> {
        Ok(self
            .entry(reference)?
            .issuer_environment()
            .map(str::to_owned))
    }

    #[wasm_bindgen(js_name = credentialType)]
    pub fn credential_type(&self, reference: f64) -> Result<String, JsValue> {
        Ok(match self.entry(reference)?.credential_type() {
            CatalogCredentialTypeV1::Password => "password",
            CatalogCredentialTypeV1::ApiKey => "api_key",
            CatalogCredentialTypeV1::OauthClient => "oauth_client",
            CatalogCredentialTypeV1::CloudAccessKey => "cloud_access_key",
            CatalogCredentialTypeV1::Token => "token",
            CatalogCredentialTypeV1::RecoveryCode => "recovery_code",
            CatalogCredentialTypeV1::Custom => "custom",
        }
        .to_owned())
    }

    pub fn status(&self, reference: f64) -> Result<String, JsValue> {
        Ok(match self.entry(reference)?.status() {
            CatalogCredentialStatusV1::Active => "active",
            CatalogCredentialStatusV1::RotationDue => "rotation_due",
            CatalogCredentialStatusV1::Rotating => "rotating",
            CatalogCredentialStatusV1::Expired => "expired",
            CatalogCredentialStatusV1::Compromised => "compromised",
            CatalogCredentialStatusV1::Revoked => "revoked",
            CatalogCredentialStatusV1::Disabled => "disabled",
            CatalogCredentialStatusV1::Unknown => "unknown",
        }
        .to_owned())
    }

    #[wasm_bindgen(js_name = connectionCount)]
    pub fn connection_count(&self, reference: f64) -> Result<u32, JsValue> {
        checked_count(self.entry(reference)?.connection_count())
    }

    #[wasm_bindgen(js_name = secretFieldCount)]
    pub fn secret_field_count(&self, reference: f64) -> Result<u32, JsValue> {
        checked_count(self.entry(reference)?.secret_field_count())
    }

    #[wasm_bindgen(js_name = mcpConnectionCount)]
    pub fn mcp_connection_count(&self, reference: f64) -> Result<u32, JsValue> {
        checked_count(self.entry(reference)?.mcp_connection_count())
    }

    #[wasm_bindgen(js_name = connectionLabel)]
    pub fn connection_label(&self, reference: f64, index: f64) -> Result<JsValue, JsValue> {
        let entry = self.entry(reference)?;
        let connection = entry
            .connection(checked_index(index)?)
            .ok_or_else(|| JsValue::from_str("INVALID_REFERENCE"))?;
        Ok(JsValue::from_str(connection.label()))
    }

    #[wasm_bindgen(js_name = connectionType)]
    pub fn connection_type(&self, reference: f64, index: f64) -> Result<String, JsValue> {
        let entry = self.entry(reference)?;
        let connection = entry
            .connection(checked_index(index)?)
            .ok_or_else(|| JsValue::from_str("INVALID_REFERENCE"))?;
        Ok(match connection.consumer_type() {
            CatalogConnectionTypeV1::App => "app",
            CatalogConnectionTypeV1::BrowserExtension => "browser_extension",
            CatalogConnectionTypeV1::Plugin => "plugin",
            CatalogConnectionTypeV1::McpServer => "mcp_server",
            CatalogConnectionTypeV1::Cli => "cli",
            CatalogConnectionTypeV1::Server => "server",
            CatalogConnectionTypeV1::CiCd => "ci_cd",
            CatalogConnectionTypeV1::CloudProject => "cloud_project",
            CatalogConnectionTypeV1::Custom => "custom",
        }
        .to_owned())
    }
}

fn checked_index(value: f64) -> Result<usize, JsValue> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > f64::from(u32::MAX) {
        return Err(JsValue::from_str("INVALID_REFERENCE"));
    }
    usize::try_from(value as u32).map_err(|_| JsValue::from_str("INVALID_REFERENCE"))
}

fn checked_count(value: usize) -> Result<u32, JsValue> {
    u32::try_from(value).map_err(|_| JsValue::from_str("LIMITS_EXCEEDED"))
}

#[cfg(all(test, feature = "synthetic-demo"))]
mod issuer_projection_tests {
    use super::*;

    #[test]
    fn issuer_getters_preserve_the_optional_source_values() {
        let snapshot = archive::create_catalog().unwrap();
        let mut catalog = WasmCatalogV1::from_snapshot(snapshot);
        for reference in 0..3 {
            let reference = f64::from(reference);
            assert!(
                catalog
                    .issuer_account_identifier(reference)
                    .unwrap()
                    .as_deref()
                    == Some("demo-account")
            );
            assert!(
                catalog
                    .issuer_organization_or_workspace(reference)
                    .unwrap()
                    .is_none()
            );
            assert!(catalog.issuer_project(reference).unwrap().as_deref() == Some("demo-project"));
            assert!(catalog.issuer_environment(reference).unwrap().as_deref() == Some("demo"));
        }
        catalog.lock();
        assert!(catalog.is_locked());
        // JS error conversion is tested by the real-WASM script, including
        // every optional getter after lock and with invalid references.
    }
}
