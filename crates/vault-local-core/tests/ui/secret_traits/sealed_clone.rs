use serde::Serialize;
use vault_crypto::VaultSession;
use vault_local_core::{
    AuthenticatedStoredCredentialRevisionV1, CredentialStorageAuthenticatorV1,
    OwnedPreservedCredentialEnvelopeV1, OwnedRehydratedCredentialOutcomeV1,
    OwnedRehydratedCredentialV1, PreservedStoredCredentialEnvelopeV1, RecordIdV1, RevisionIdV1,
    SealedCredentialRecordV0Alpha1, StoredCredentialAuthenticationOutcomeV1,
    SyntheticCredentialSuccessorV1, create_synthetic_successor_v1,
};

fn requires_serialize<T: Serialize>(_: &T) {}

fn forbidden_traits(
    session: &VaultSession,
    sealed: SealedCredentialRecordV0Alpha1,
    receipt: AuthenticatedStoredCredentialRevisionV1<'_>,
    preserved: PreservedStoredCredentialEnvelopeV1<'_>,
    successor: SyntheticCredentialSuccessorV1,
    owned: OwnedRehydratedCredentialV1,
    owned_preserved: OwnedPreservedCredentialEnvelopeV1,
    borrowed_outcome: StoredCredentialAuthenticationOutcomeV1<'_>,
    owned_outcome: OwnedRehydratedCredentialOutcomeV1,
) {
    let _ = sealed.clone();
    let projection = sealed.persistence_projection_v1();
    let _ = projection.clone();
    let authenticator = CredentialStorageAuthenticatorV1::new(session);
    let _ = authenticator.clone();
    let _ = receipt.clone();
    let _ = preserved.clone();
    let _ = successor.clone();
    let _ = owned.clone();
    let _ = owned_preserved.clone();
    let _ = borrowed_outcome.clone();
    let _ = owned_outcome.clone();
    let _ = format!("{projection:?}");
    let _ = format!("{receipt:?}");
    let _ = format!("{owned:?}");
    let _ = format!("{authenticator}");
    let _ = format!("{preserved}");
    let _ = format!("{successor}");
    requires_serialize(&sealed);
    requires_serialize(&projection);
    requires_serialize(&authenticator);
    requires_serialize(&receipt);
    requires_serialize(&preserved);
    requires_serialize(&successor);
    requires_serialize(&owned);
    requires_serialize(&owned_preserved);
    requires_serialize(&borrowed_outcome);
    requires_serialize(&owned_outcome);
    let _ = RecordIdV1::from_bytes([0_u8; 16]);
    let _ = RevisionIdV1::from_bytes([0_u8; 32]);
    let entropy = [0_u8; 32];
    let aad = [0_u8; 32];
    let nonce = [0_u8; 24];
    let _ = create_synthetic_successor_v1(session, &sealed, entropy, aad, nonce);
}

fn main() {}
