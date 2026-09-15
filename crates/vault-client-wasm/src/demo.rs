use crate::WasmCatalogV1;
use crate::archive;
use wasm_bindgen::prelude::*;

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
}
