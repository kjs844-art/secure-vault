use vault_crypto::{
    CreatedVaultV0Alpha1, CryptoError, CryptoErrorCode, KeyEpoch, MasterPassword, OpaqueRecordId,
    PaddingBucketV0Alpha1, RecordContextV0Alpha1, RevisionId, SecretBytes, create_vault_v0alpha1,
    open_record_v0alpha1, seal_record_v0alpha1, unlock_vault_v0alpha1,
};

const SYNTHETIC_PASSWORD: &str = "synthetic vector phrase";
const SYNTHETIC_PAYLOAD: &str = "DEMO_VALUE_ONLY_0001";

fn run_synthetic_flow() -> Result<bool, CryptoError> {
    let password = MasterPassword::from_utf8(SYNTHETIC_PASSWORD.to_owned())?;
    let CreatedVaultV0Alpha1 {
        password_envelope,
        session: created_session,
    } = create_vault_v0alpha1(&password)?;
    let commitment = created_session.commitment();
    drop(created_session);

    let unlocked_session = unlock_vault_v0alpha1(&password, &password_envelope)?;
    let context = RecordContextV0Alpha1::new(
        commitment,
        OpaqueRecordId::from_bytes([17; 16]),
        RevisionId::from_bytes([34; 32]),
        KeyEpoch::new(1)?,
        PaddingBucketV0Alpha1::Bytes1024,
    );
    let plaintext = SecretBytes::new(SYNTHETIC_PAYLOAD.as_bytes().to_vec())?;
    let record_envelope = seal_record_v0alpha1(&unlocked_session, &context, &plaintext)?;

    let mut tampered = record_envelope.clone();
    let last = tampered.last_mut().ok_or(CryptoError::InvalidLength)?;
    *last ^= 0x01;
    let tamper_rejected = matches!(
        open_record_v0alpha1(&unlocked_session, &context, &tampered),
        Err(error) if error.code() == CryptoErrorCode::AuthenticationFailed
    );
    let opened = open_record_v0alpha1(&unlocked_session, &context, &record_envelope)?;

    Ok(tamper_rejected && opened.expose_secret() == SYNTHETIC_PAYLOAD.as_bytes())
}

fn main() {
    if !matches!(run_synthetic_flow(), Ok(true)) {
        std::process::exit(1);
    }

    println!("SYNTHETIC_ALPHA_OK");
    println!("items=1");
    println!("tamper_rejected=true");
}
