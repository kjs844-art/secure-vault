use super::{SyntheticInvalidFixtureId, UtcTimestampV1, validate_invalid_fixture_v1};
use crate::{LocalVaultError, LocalVaultErrorCode};

fn expect_local_error_code<T>(result: Result<T, LocalVaultError>) -> LocalVaultErrorCode {
    match result {
        Ok(_) => panic!("an invalid synthetic model case was unexpectedly accepted"),
        Err(error) => error.code(),
    }
}

#[test]
fn item_and_reference_limits_fail_closed() {
    for fixture in [
        SyntheticInvalidFixtureId::EmptyItemName,
        SyntheticInvalidFixtureId::DanglingMcpFieldBinding,
        SyntheticInvalidFixtureId::DuplicateConnectionId,
        SyntheticInvalidFixtureId::DuplicateSecretFieldId,
        SyntheticInvalidFixtureId::McpPayloadOnNonMcpConsumer,
        SyntheticInvalidFixtureId::DuplicateMcpBinding,
        SyntheticInvalidFixtureId::RotationParentMismatch,
        SyntheticInvalidFixtureId::RequiredConnectionSetMismatch,
        SyntheticInvalidFixtureId::CompletedConnectionOutsideRequiredSet,
        SyntheticInvalidFixtureId::InvalidSupersededRevocationAttestation,
        SyntheticInvalidFixtureId::SelfParentRevision,
    ] {
        assert_eq!(
            expect_local_error_code(validate_invalid_fixture_v1(fixture)),
            LocalVaultErrorCode::InvalidItem,
        );
    }
}

#[test]
fn byte_limits_return_one_stable_code() {
    for fixture in [
        SyntheticInvalidFixtureId::ItemNameOver128Bytes,
        SyntheticInvalidFixtureId::ConsoleUrlOver2048Bytes,
        SyntheticInvalidFixtureId::NotesOver8192Bytes,
        SyntheticInvalidFixtureId::TooManySecretFields,
        SyntheticInvalidFixtureId::SecretBytesOverLimit,
        SyntheticInvalidFixtureId::TooManyConnections,
    ] {
        assert_eq!(
            expect_local_error_code(validate_invalid_fixture_v1(fixture)),
            LocalVaultErrorCode::LimitsExceeded,
        );
    }
}

#[test]
fn utc_timestamps_accept_only_exact_valid_calendar_values() {
    assert!(UtcTimestampV1::new("2024-02-29T23:59:59Z".to_owned()).is_ok());
    for invalid in [
        "2025-02-29T23:59:59Z",
        "2026-13-01T00:00:00Z",
        "2026-01-32T00:00:00Z",
        "2026-01-01T24:00:00Z",
        "2026-01-01T00:60:00Z",
        "2026-01-01T00:00:60Z",
        "2026-01-01T00:00:00+00:00",
    ] {
        assert_eq!(
            expect_local_error_code(UtcTimestampV1::new(invalid.to_owned())),
            LocalVaultErrorCode::InvalidItem,
        );
    }
}
