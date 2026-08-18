#[test]
fn storage_inspection_types_do_not_gain_constructors_or_clone_traits() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/storage_traits/*.rs");
}
