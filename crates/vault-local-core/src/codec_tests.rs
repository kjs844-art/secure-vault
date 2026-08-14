use super::{
    SyntheticCodecMutation, reject_synthetic_codec_mutation_v1,
    synthetic_codec_roundtrip_with_note_length, synthetic_fully_populated_codec_roundtrip_v1,
    synthetic_well_formed_future_version_v1,
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
            SyntheticCodecMutation::EmptyTopLevelArrayWithExternalFutureVersion,
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

#[test]
fn fully_populated_synthetic_item_roundtrips() {
    assert!(synthetic_fully_populated_codec_roundtrip_v1().is_ok());
}

#[test]
fn well_formed_future_version_requests_upgrade() {
    assert_eq!(synthetic_well_formed_future_version_v1().unwrap(), 2);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    #[test]
    fn bounded_synthetic_notes_roundtrip(note_len in 0_usize..=8_192) {
        prop_assert!(synthetic_codec_roundtrip_with_note_length(note_len).is_ok());
    }
}
