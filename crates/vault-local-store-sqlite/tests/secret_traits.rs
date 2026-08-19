#[test]
fn sqlite_store_surface_stays_closed_to_secret_exposure_and_generic_capabilities() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/secret_traits/*.rs");
}
