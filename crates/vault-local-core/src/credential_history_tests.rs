//! Local synthetic inputs only; generic integrity never authorizes Secret use.

use vault_crypto::{MasterPassword, VaultSession, create_vault_v0alpha1, seal_record_v0alpha1};

use super::*;
use crate::LocalVaultErrorCode;
use crate::codec::encode_current_item;
use crate::ids::RecordIdV1;
use crate::model::{CredentialItemV1, CredentialTypeV1};
use crate::record::{
    StoredPaddingBucketV0Alpha1, record_context, seal_synthetic_future_inner_v2,
    sealed_from_current_envelope, select_bucket,
};
use crate::synthetic::{SyntheticCredentialFixtureId, build_synthetic_fixture_v1};

fn session() -> VaultSession {
    let password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_credential_chain".to_owned()).unwrap();
    create_vault_v0alpha1(&password).unwrap().session
}

fn revision(index: u16) -> RevisionIdV1 {
    let mut bytes = [0x78; 32];
    bytes[..2].copy_from_slice(&index.to_le_bytes());
    RevisionIdV1::from_bytes(bytes)
}

fn record_id() -> RecordIdV1 {
    RecordIdV1::from_bytes([0x48; 16])
}

fn item(kind: CredentialTypeV1, parent: Option<RevisionIdV1>) -> CredentialItemV1 {
    let mut item =
        build_synthetic_fixture_v1(SyntheticCredentialFixtureId::UnconnectedApiKey).unwrap();
    item.credential_type = kind;
    item.parent_revision_id = parent;
    // Deliberately no type-specific closed Password fixture here. This unit
    // exercises generic chain integrity, not a Password admission policy.
    item
}

fn seal_at(
    session: &VaultSession,
    item: CredentialItemV1,
    record_id: RecordIdV1,
    revision_id: RevisionIdV1,
) -> SealedCredentialRecordV0Alpha1 {
    let plaintext = encode_current_item(&item, revision_id).unwrap();
    let bucket = select_bucket(plaintext.expose_secret().len()).unwrap();
    let context = record_context(
        session,
        record_id,
        revision_id,
        session.key_epoch().get(),
        bucket,
    )
    .unwrap();
    sealed_from_current_envelope(seal_record_v0alpha1(session, &context, &plaintext).unwrap())
        .unwrap()
}

fn code<T>(result: Result<T, LocalVaultError>) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("invalid synthetic credential chain must fail closed"),
        Err(error) => error.code(),
    }
}

#[test]
fn password_and_api_chains_accept_unordered_ancestors_and_older_heads_without_mutation() {
    let session = session();
    for (kind, expected) in [
        (
            CredentialTypeV1::Password,
            CatalogCredentialTypeV1::Password,
        ),
        (CredentialTypeV1::ApiKey, CatalogCredentialTypeV1::ApiKey),
    ] {
        let root = seal_at(&session, item(kind, None), record_id(), revision(0));
        let middle = seal_at(
            &session,
            item(kind, Some(revision(0))),
            record_id(),
            revision(1),
        );
        let head = seal_at(
            &session,
            item(kind, Some(revision(1))),
            record_id(),
            revision(2),
        );
        let before: Vec<_> = [&root, &middle, &head]
            .iter()
            .map(|record| record.envelope.clone())
            .collect();
        let result = inspect_credential_chain_v1(&session, &head, &[&root, &middle]).unwrap();
        assert!(result.credential_type() == expected);
        assert_eq!(result.revision_count(), 3);
        let older = inspect_credential_chain_v1(&session, &middle, &[&root]).unwrap();
        assert!(older.credential_type() == expected);
        assert_eq!(older.revision_count(), 2);
        assert_eq!(
            inspect_credential_chain_v1(&session, &root, &[])
                .unwrap()
                .revision_count(),
            1
        );
        for (record, bytes) in [&root, &middle, &head].into_iter().zip(before) {
            assert!(record.envelope == bytes);
        }
    }
}

#[test]
fn rejects_type_switches_in_both_directions_and_a_hidden_middle_switch() {
    let session = session();
    for (first, second) in [
        (CredentialTypeV1::Password, CredentialTypeV1::ApiKey),
        (CredentialTypeV1::ApiKey, CredentialTypeV1::Password),
    ] {
        let root = seal_at(&session, item(first, None), record_id(), revision(0));
        let switched = seal_at(
            &session,
            item(second, Some(revision(0))),
            record_id(),
            revision(1),
        );
        let restored = seal_at(
            &session,
            item(first, Some(revision(1))),
            record_id(),
            revision(2),
        );
        for (head, ancestors) in [
            (&switched, vec![&root]),
            (&restored, vec![&root, &switched]),
        ] {
            assert_eq!(
                code(inspect_credential_chain_v1(&session, head, &ancestors)),
                LocalVaultErrorCode::InvalidItem
            );
        }
    }
}

#[test]
fn rejects_missing_duplicate_foreign_and_unused_revisions() {
    let session = session();
    let kind = CredentialTypeV1::Password;
    let root = seal_at(&session, item(kind, None), record_id(), revision(0));
    let head = seal_at(
        &session,
        item(kind, Some(revision(0))),
        record_id(),
        revision(1),
    );
    let sibling = seal_at(
        &session,
        item(kind, Some(revision(0))),
        record_id(),
        revision(2),
    );
    let foreign = seal_at(
        &session,
        item(kind, None),
        RecordIdV1::from_bytes([0x49; 16]),
        revision(3),
    );
    let unused_root = seal_at(&session, item(kind, None), record_id(), revision(4));
    for ancestors in [
        vec![],
        vec![&root, &root],
        vec![&root, &head],
        vec![&root, &sibling],
        vec![&root, &foreign],
        vec![&root, &unused_root],
    ] {
        assert_eq!(
            code(inspect_credential_chain_v1(&session, &head, &ancestors)),
            LocalVaultErrorCode::InvalidItem
        );
    }
}

#[test]
fn rejects_authenticated_multi_revision_cycles() {
    let session = session();
    let kind = CredentialTypeV1::ApiKey;
    let first = seal_at(
        &session,
        item(kind, Some(revision(1))),
        record_id(),
        revision(0),
    );
    let second = seal_at(
        &session,
        item(kind, Some(revision(0))),
        record_id(),
        revision(1),
    );
    assert_eq!(
        code(inspect_credential_chain_v1(&session, &second, &[&first])),
        LocalVaultErrorCode::InvalidItem
    );
}

#[test]
fn authenticates_heads_ancestors_and_unused_envelopes_and_preserves_bytes() {
    let session = session();
    let kind = CredentialTypeV1::Password;
    let root = seal_at(&session, item(kind, None), record_id(), revision(0));
    let head = seal_at(
        &session,
        item(kind, Some(revision(0))),
        record_id(),
        revision(1),
    );
    let mut bad_root = sealed_from_current_envelope(root.envelope.clone()).unwrap();
    let mut bad_head = sealed_from_current_envelope(head.envelope.clone()).unwrap();
    *bad_root.envelope.last_mut().unwrap() ^= 1;
    *bad_head.envelope.last_mut().unwrap() ^= 1;
    let before = [bad_root.envelope.clone(), bad_head.envelope.clone()];
    for (selected, ancestors) in [
        (&head, vec![&bad_root]),
        (&bad_head, vec![&root]),
        (&root, vec![&bad_head]),
    ] {
        assert_eq!(
            code(inspect_credential_chain_v1(&session, selected, &ancestors)),
            LocalVaultErrorCode::AuthenticationFailed
        );
    }
    assert!(bad_root.envelope == before[0]);
    assert!(bad_head.envelope == before[1]);
}

#[test]
fn different_vault_session_cannot_authenticate_a_chain() {
    let session = session();
    let root = seal_at(
        &session,
        item(CredentialTypeV1::Password, None),
        record_id(),
        revision(0),
    );
    let other_password =
        MasterPassword::from_utf8("DEMO_VALUE_ONLY_other_chain_vault".to_owned()).unwrap();
    let other = create_vault_v0alpha1(&other_password).unwrap().session;
    assert_eq!(
        code(inspect_credential_chain_v1(&other, &root, &[])),
        LocalVaultErrorCode::AuthenticationFailed
    );
}

#[test]
fn derives_all_identity_from_canonical_envelopes_not_mutated_cached_locators() {
    let session = session();
    let kind = CredentialTypeV1::Password;
    let mut root = seal_at(&session, item(kind, None), record_id(), revision(0));
    let mut head = seal_at(
        &session,
        item(kind, Some(revision(0))),
        record_id(),
        revision(1),
    );
    for record in [&mut root, &mut head] {
        record.vault_commitment = [0x99; 32];
        record.locator.record_id = RecordIdV1::from_bytes([0x99; 16]);
        record.locator.revision_id = revision(90);
        record.locator.key_epoch = u32::MAX;
        record.locator.padding_bucket = StoredPaddingBucketV0Alpha1::Bytes61440;
    }
    let before = [root.envelope.clone(), head.envelope.clone()];
    let inspected = inspect_credential_chain_v1(&session, &head, &[&root]).unwrap();
    assert!(inspected.credential_type() == CatalogCredentialTypeV1::Password);
    assert_eq!(inspected.revision_count(), 2);
    assert!(root.envelope == before[0]);
    assert!(head.envelope == before[1]);
}

#[test]
fn rejects_future_inner_and_outer_versions_without_modifying_input() {
    let session = session();
    let inner = seal_synthetic_future_inner_v2(&session).unwrap();
    let mut outer = seal_at(
        &session,
        item(CredentialTypeV1::ApiKey, None),
        record_id(),
        revision(0),
    );
    assert_eq!(outer.envelope[0], 0x8c);
    assert_eq!(outer.envelope[1], 0);
    outer.envelope[1] = 1;
    for record in [&inner, &outer] {
        let before = record.envelope.clone();
        assert_eq!(
            code(inspect_credential_chain_v1(&session, record, &[])),
            LocalVaultErrorCode::CryptoFailure
        );
        assert!(record.envelope == before);
    }
}

#[test]
fn accepts_512_revisions_and_rejects_513_before_authenticating() {
    let session = session();
    let records: Vec<_> = (0..MAX_CHAIN_REVISIONS)
        .map(|index| {
            let parent = index.checked_sub(1).map(|value| revision(value as u16));
            seal_at(
                &session,
                item(CredentialTypeV1::Password, parent),
                record_id(),
                revision(index as u16),
            )
        })
        .collect();
    let head = &records[MAX_CHAIN_REVISIONS - 1];
    let ancestors: Vec<_> = records[..MAX_CHAIN_REVISIONS - 1].iter().collect();
    let inspected = inspect_credential_chain_v1(&session, head, &ancestors).unwrap();
    assert_eq!(inspected.revision_count(), MAX_CHAIN_REVISIONS);
    assert_eq!(
        code(inspect_credential_chain_v1(
            &session,
            head,
            &[head; MAX_CHAIN_REVISIONS]
        )),
        LocalVaultErrorCode::LimitsExceeded
    );
}

#[test]
fn aggregate_ciphertext_limit_is_checked_before_any_authentication() {
    let session = session();
    let mut invalid = seal_at(
        &session,
        item(CredentialTypeV1::ApiKey, None),
        record_id(),
        revision(0),
    );
    // Individually bounded envelopes account for exactly 8 MiB. Their invalid
    // framing must then reach authentication rather than aggregate rejection.
    invalid.envelope = vec![0; MAX_CHAIN_CIPHERTEXT_BYTES / MAX_CHAIN_REVISIONS];
    let ancestors = [&invalid; MAX_CHAIN_REVISIONS - 1];
    assert_eq!(
        validate_chain_size_limits(&invalid, &ancestors).unwrap(),
        MAX_CHAIN_REVISIONS
    );
    assert!(
        code(inspect_credential_chain_v1(&session, &invalid, &ancestors))
            != LocalVaultErrorCode::LimitsExceeded
    );
    // Count stays at 512; only aggregate ciphertext size now exceeds its bound.
    invalid.envelope.push(0);
    assert_eq!(
        code(inspect_credential_chain_v1(
            &session,
            &invalid,
            &[&invalid; MAX_CHAIN_REVISIONS - 1]
        )),
        LocalVaultErrorCode::LimitsExceeded
    );
}
