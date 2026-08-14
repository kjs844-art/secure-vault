use super::{
    SyntheticCodecMutation, reject_synthetic_codec_mutation_v1,
    synthetic_codec_roundtrip_with_note_length,
};
use crate::LocalVaultErrorCode;
use proptest::prelude::*;

#[test]
fn current_schema_rejects_alternative_or_malformed_encodings() {
    for (mutation, expected) in [
        (
            SyntheticCodecMutation::WrongTopLevelArrayLength,
            LocalVaultErrorCode::NonCanonicalEncoding,
        ),
        (
            SyntheticCodecMutation::WrongNestedArrayLength,
            LocalVaultErrorCode::NonCanonicalEncoding,
        ),
        (
            SyntheticCodecMutation::IndefiniteTopLevelArray,
            LocalVaultErrorCode::NonCanonicalEncoding,
        ),
        (
            SyntheticCodecMutation::IndefiniteText,
            LocalVaultErrorCode::NonCanonicalEncoding,
        ),
        (
            SyntheticCodecMutation::NonMinimalSchemaVersion,
            LocalVaultErrorCode::NonCanonicalEncoding,
        ),
        (
            SyntheticCodecMutation::SchemaVersionZero,
            LocalVaultErrorCode::InvalidItem,
        ),
        (
            SyntheticCodecMutation::RawPayloadOverProductLimit,
            LocalVaultErrorCode::LimitsExceeded,
        ),
        (
            SyntheticCodecMutation::EncodedItemOverProductLimit,
            LocalVaultErrorCode::LimitsExceeded,
        ),
        (
            SyntheticCodecMutation::DeclaredConnectionCountOverLimit,
            LocalVaultErrorCode::LimitsExceeded,
        ),
        (
            SyntheticCodecMutation::TruncatedPayload,
            LocalVaultErrorCode::NonCanonicalEncoding,
        ),
        (
            SyntheticCodecMutation::InvalidUtf8,
            LocalVaultErrorCode::NonCanonicalEncoding,
        ),
        (
            SyntheticCodecMutation::TrailingBytes,
            LocalVaultErrorCode::NonCanonicalEncoding,
        ),
        (
            SyntheticCodecMutation::UnknownCurrentEnum,
            LocalVaultErrorCode::InvalidItem,
        ),
        (
            SyntheticCodecMutation::DuplicateFieldId,
            LocalVaultErrorCode::InvalidItem,
        ),
    ] {
        let code = reject_synthetic_codec_mutation_v1(mutation)
            .unwrap_err()
            .code();
        assert_eq!(code, expected);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    #[test]
    fn bounded_synthetic_notes_roundtrip(note_len in 0_usize..=8_192) {
        prop_assert!(synthetic_codec_roundtrip_with_note_length(note_len).is_ok());
    }
}
