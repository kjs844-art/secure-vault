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

fn archive_js_error(error: archive::ArchiveError) -> JsValue {
    JsValue::from_str(error.code())
}
