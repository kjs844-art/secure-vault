use vault_crypto::{MasterPassword, create_vault_v0alpha1};

use crate::{OpenCredentialOutcome, SyntheticFutureVersion, open_synthetic_future_version_v1};

#[test]
fn future_inner_and_outer_versions_require_upgrade_without_mutation() {
    let password = MasterPassword::from_utf8("synthetic future phrase".to_owned()).unwrap();
    let created = create_vault_v0alpha1(&password).unwrap();

    for version in [
        SyntheticFutureVersion::InnerSchema2,
        SyntheticFutureVersion::OuterWire1,
    ] {
        let (before, outcome, after) =
            open_synthetic_future_version_v1(&created.session, version).unwrap();
        assert!(matches!(outcome, OpenCredentialOutcome::UpgradeRequired));
        assert_eq!(before, after);
    }
}
