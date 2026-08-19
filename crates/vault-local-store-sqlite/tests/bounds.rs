use std::fs;

#[test]
fn task_five_modules_cannot_bypass_the_closed_query_gate() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for file in ["preflight.rs", "rows.rs", "digest.rs", "schema_contract.rs"] {
        let source = fs::read_to_string(root.join(file)).unwrap();
        for forbidden in [
            "Connection",
            "Statement",
            "Row",
            ".prepare(",
            ".query(",
            ".execute(",
            "schema::",
        ] {
            assert!(!source.contains(forbidden), "{file} exposes {forbidden}");
        }
    }
}

#[test]
fn digest_and_row_boundaries_are_declared_without_attacker_count_allocation() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let gate = fs::read_to_string(root.join("preflight_query.rs")).unwrap();
    assert!(gate.contains("MAX_TOTAL_REVISION_ENVELOPE_BYTES"));
    assert!(gate.contains("checked_add"));
    assert!(gate.contains("length(envelope)"));
    assert!(gate.contains("typeof(envelope)"));
}
