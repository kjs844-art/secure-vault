#[test]
fn client_catalog_does_not_gain_generic_exfiltration_traits() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/secret_traits/*.rs");
}
