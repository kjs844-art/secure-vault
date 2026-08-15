#[test]
fn opened_credentials_do_not_gain_secret_exposing_traits() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/secret_traits/*.rs");
}
