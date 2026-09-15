#[test]
fn opened_credentials_do_not_gain_secret_exposing_traits() {
    // Every fixture names one deliberate compile-time boundary violation.
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/secret_traits/*.rs");
}
