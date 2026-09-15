#[test]
fn secret_types_do_not_gain_logging_or_clone_traits() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/secret_traits/*.rs");
}
