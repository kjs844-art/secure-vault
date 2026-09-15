use vault_crypto::{
    MasterPassword, PasswordEnvelopeStorageDispositionV1, create_vault_v0alpha1,
    inspect_password_envelope_for_storage_v1, unlock_vault_v0alpha1,
};
use vault_local_core::{
    CredentialStorageAuthenticatorV1, SyntheticCredentialFixtureId, seal_synthetic_fixture_v1,
};
use vault_local_store_sqlite::{
    ExistingVaultPreflightOutcomeV1, InitializeStoreOutcomeV1, StoreLocationPolicyV1,
    TrustedLocalAppDataRootV1, initialize_v1, preflight_existing_v1,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let trusted_root = TrustedLocalAppDataRootV1::for_current_user()?;
    let policy = StoreLocationPolicyV1::new(&trusted_root, directory.path())?;
    let location = policy.location("synthetic.sqlite3")?;
    let password_text = "DEMO_VALUE_ONLY_example_restart.invalid";
    let password = MasterPassword::from_utf8(password_text.to_owned())?;
    let created = create_vault_v0alpha1(&password)?;
    let PasswordEnvelopeStorageDispositionV1::Current(inspection) =
        inspect_password_envelope_for_storage_v1(&created.password_envelope)?
    else {
        return Err("synthetic password envelope was not current".into());
    };
    let mut store = match initialize_v1(&location, inspection.bootstrap_projection())? {
        InitializeStoreOutcomeV1::Created(store) => store,
        InitializeStoreOutcomeV1::AlreadyInitialized => {
            return Err("temporary synthetic store already existed".into());
        }
    };
    println!("synthetic store initialized");
    let record = seal_synthetic_fixture_v1(
        &created.session,
        SyntheticCredentialFixtureId::SingleMcpConnection,
    )?;
    store.commit_candidate(record.persistence_projection_v1())?;
    println!("encrypted revision committed");
    drop(record);
    drop(store);
    drop(created);
    drop(password);

    let preflight = match preflight_existing_v1(&location)? {
        ExistingVaultPreflightOutcomeV1::Current(preflight) => preflight,
        _ => return Err("synthetic store did not reopen structurally".into()),
    };
    println!("store closed and reopened locked");
    let password = MasterPassword::from_utf8(password_text.to_owned())?;
    let session = unlock_vault_v0alpha1(&password, preflight.password_envelope())?;
    let authenticator = CredentialStorageAuthenticatorV1::new(&session);
    let authenticated = preflight
        .authenticate_current_revisions(&authenticator)?
        .into_authenticated()
        .ok_or("synthetic revisions did not authenticate")?;
    let opened = authenticated.promote()?;
    let (_store, heads) = opened
        .into_parts()
        .ok_or("synthetic current store did not promote")?;
    if heads.len() != 1 {
        return Err("synthetic canonical head count was not one".into());
    }
    println!("synthetic relationship authenticated");
    Ok(())
}
