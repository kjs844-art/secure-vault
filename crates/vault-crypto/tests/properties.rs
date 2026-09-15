use std::panic::{AssertUnwindSafe, catch_unwind};

use proptest::prelude::*;
use vault_crypto::{inspect_password_envelope_v0alpha1, inspect_record_envelope_v0alpha1};

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 256,
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn public_envelope_inspectors_return_without_panicking(
        input in proptest::collection::vec(any::<u8>(), 0..=70_000),
    ) {
        let password_result = catch_unwind(AssertUnwindSafe(|| {
            inspect_password_envelope_v0alpha1(&input)
        }));
        prop_assert!(password_result.is_ok());

        let record_result = catch_unwind(AssertUnwindSafe(|| {
            inspect_record_envelope_v0alpha1(&input)
        }));
        prop_assert!(record_result.is_ok());
    }
}
