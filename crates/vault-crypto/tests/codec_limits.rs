use vault_crypto::{
    CryptoErrorCode, inspect_password_envelope_v0alpha1, inspect_record_envelope_v0alpha1,
};

const SUITE_ID: u64 = 0xA101;

fn push_uint(output: &mut Vec<u8>, value: u64) {
    match value {
        0..=23 => output.push(value as u8),
        24..=0xff => {
            output.push(0x18);
            output.push(value as u8);
        }
        0x100..=0xffff => {
            output.push(0x19);
            output.extend_from_slice(&(value as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            output.push(0x1a);
            output.extend_from_slice(&(value as u32).to_be_bytes());
        }
        _ => {
            output.push(0x1b);
            output.extend_from_slice(&value.to_be_bytes());
        }
    }
}

fn push_bytes(output: &mut Vec<u8>, bytes: &[u8]) {
    match bytes.len() {
        0..=23 => output.push(0x40 | bytes.len() as u8),
        24..=0xff => {
            output.push(0x58);
            output.push(bytes.len() as u8);
        }
        0x100..=0xffff => {
            output.push(0x59);
            output.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
        }
        _ => panic!("test fixture is intentionally bounded below 64 KiB"),
    }
    output.extend_from_slice(bytes);
}

fn password_envelope(
    version: u64,
    suite: u64,
    kind: u64,
    salt_len: usize,
    memory_kib: u64,
    time_cost: u64,
    lanes: u64,
) -> Vec<u8> {
    let mut output = vec![0x8a];
    push_uint(&mut output, version);
    push_uint(&mut output, suite);
    push_uint(&mut output, kind);
    push_bytes(&mut output, &vec![0x11; salt_len]);
    push_uint(&mut output, memory_kib);
    push_uint(&mut output, time_cost);
    push_uint(&mut output, lanes);
    push_bytes(&mut output, &[0x22; 32]);
    push_bytes(&mut output, &[0x33; 24]);
    push_bytes(&mut output, &[0x44; 48]);
    output
}

fn valid_password_envelope() -> Vec<u8> {
    password_envelope(0, SUITE_ID, 1, 16, 65_536, 3, 4)
}

fn record_envelope(
    version: u64,
    suite: u64,
    kind: u64,
    commitment_len: usize,
    epoch: u64,
    bucket: u64,
    encrypted_body_len: usize,
) -> Vec<u8> {
    let mut output = vec![0x8c];
    push_uint(&mut output, version);
    push_uint(&mut output, suite);
    push_uint(&mut output, kind);
    push_bytes(&mut output, &vec![0x51; commitment_len]);
    push_bytes(&mut output, &[0x52; 16]);
    push_bytes(&mut output, &[0x53; 32]);
    push_uint(&mut output, epoch);
    push_uint(&mut output, bucket);
    push_bytes(&mut output, &[0x54; 24]);
    push_bytes(&mut output, &[0x55; 48]);
    push_bytes(&mut output, &[0x56; 24]);
    push_bytes(&mut output, &vec![0x57; encrypted_body_len]);
    output
}

fn valid_record_envelope() -> Vec<u8> {
    record_envelope(0, SUITE_ID, 2, 32, 1, 1_024, 1_040)
}

#[test]
fn accepts_canonical_password_and_record_envelopes() {
    assert!(inspect_password_envelope_v0alpha1(&valid_password_envelope()).is_ok());
    assert!(inspect_record_envelope_v0alpha1(&valid_record_envelope()).is_ok());
}

#[test]
fn rejects_oversized_input_before_decoding() {
    let input = vec![0_u8; 65_537];
    let error = inspect_password_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::LimitsExceeded);

    let error = inspect_record_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::LimitsExceeded);
}

#[test]
fn rejects_empty_input_without_panicking() {
    let error = inspect_password_envelope_v0alpha1(&[]).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);

    let error = inspect_record_envelope_v0alpha1(&[]).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);
}

#[test]
fn rejects_truncated_cbor() {
    let mut input = valid_password_envelope();
    input.pop();
    let error = inspect_password_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);
}

#[test]
fn rejects_wrong_fixed_array_length() {
    let mut input = valid_password_envelope();
    input[0] = 0x89;
    let error = inspect_password_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);

    let mut input = valid_record_envelope();
    input[0] = 0x8b;
    let error = inspect_record_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);
}

#[test]
fn rejects_indefinite_array_and_byte_strings() {
    let error = inspect_password_envelope_v0alpha1(&[0x9f, 0xff]).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);

    let mut input = valid_password_envelope();
    input[6] = 0x5f;
    let error = inspect_password_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);
}

#[test]
fn rejects_non_minimal_integer_encoding() {
    let canonical = valid_password_envelope();
    let mut input = Vec::with_capacity(canonical.len() + 1);
    input.push(canonical[0]);
    input.extend_from_slice(&[0x18, 0x00]);
    input.extend_from_slice(&canonical[2..]);

    let error = inspect_password_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);
}

#[test]
fn rejects_alternate_array_and_byte_length_encodings() {
    let canonical = valid_password_envelope();

    let mut alternate_array = Vec::with_capacity(canonical.len() + 1);
    alternate_array.extend_from_slice(&[0x98, 0x0a]);
    alternate_array.extend_from_slice(&canonical[1..]);
    let error = inspect_password_envelope_v0alpha1(&alternate_array).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);

    let mut alternate_bytes = Vec::with_capacity(canonical.len() + 1);
    alternate_bytes.extend_from_slice(&canonical[..6]);
    alternate_bytes.extend_from_slice(&[0x58, 0x10]);
    alternate_bytes.extend_from_slice(&canonical[7..]);
    let error = inspect_password_envelope_v0alpha1(&alternate_bytes).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);
}

#[test]
fn noncanonical_encoding_precedes_unsupported_password_header_errors() {
    let canonical = valid_password_envelope();

    let mut unsupported_version = Vec::with_capacity(canonical.len() + 1);
    unsupported_version.push(canonical[0]);
    unsupported_version.extend_from_slice(&[0x18, 0x01]);
    unsupported_version.extend_from_slice(&canonical[2..]);
    let error = inspect_password_envelope_v0alpha1(&unsupported_version).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);

    let mut unsupported_suite = Vec::with_capacity(canonical.len() + 2);
    unsupported_suite.extend_from_slice(&canonical[..2]);
    unsupported_suite.push(0x1a);
    unsupported_suite.extend_from_slice(&((SUITE_ID + 1) as u32).to_be_bytes());
    unsupported_suite.extend_from_slice(&canonical[5..]);
    let error = inspect_password_envelope_v0alpha1(&unsupported_suite).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);
}

#[test]
fn noncanonical_encoding_precedes_password_semantic_field_errors() {
    let invalid_kdf = password_envelope(0, SUITE_ID, 1, 16, 65_535, 3, 4);
    let mut alternate_array = Vec::with_capacity(invalid_kdf.len() + 1);
    alternate_array.extend_from_slice(&[0x98, 0x0a]);
    alternate_array.extend_from_slice(&invalid_kdf[1..]);

    let error = inspect_password_envelope_v0alpha1(&alternate_array).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);
}

#[test]
fn rejects_noncanonical_record_integer_array_and_trailing_bytes() {
    let canonical = valid_record_envelope();

    let mut non_minimal_integer = Vec::with_capacity(canonical.len() + 1);
    non_minimal_integer.push(canonical[0]);
    non_minimal_integer.extend_from_slice(&[0x18, 0x00]);
    non_minimal_integer.extend_from_slice(&canonical[2..]);
    let error = inspect_record_envelope_v0alpha1(&non_minimal_integer).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);

    let mut alternate_array = Vec::with_capacity(canonical.len() + 1);
    alternate_array.extend_from_slice(&[0x98, 0x0c]);
    alternate_array.extend_from_slice(&canonical[1..]);
    let error = inspect_record_envelope_v0alpha1(&alternate_array).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);

    let mut trailing = canonical;
    trailing.push(0);
    let error = inspect_record_envelope_v0alpha1(&trailing).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);
}

#[test]
fn rejects_trailing_bytes() {
    let mut input = valid_password_envelope();
    input.push(0);
    let error = inspect_password_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);
}

#[test]
fn rejects_unsupported_version_before_other_semantic_checks() {
    let input = password_envelope(1, SUITE_ID + 1, 1, 15, 1, 1, 1);
    let error = inspect_password_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::UnsupportedVersion);
}

#[test]
fn rejects_unsupported_suite_before_kind_and_length_checks() {
    let input = password_envelope(0, SUITE_ID + 1, 2, 15, 1, 1, 1);
    let error = inspect_password_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::UnsupportedSuite);
}

#[test]
fn rejects_wrong_object_kind_for_each_decoder() {
    let input = password_envelope(0, SUITE_ID, 2, 16, 65_536, 3, 4);
    let error = inspect_password_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);

    let input = record_envelope(0, SUITE_ID, 1, 32, 1, 1_024, 1_040);
    let error = inspect_record_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::NonCanonicalEncoding);
}

#[test]
fn rejects_wrong_fixed_byte_field_lengths() {
    let input = password_envelope(0, SUITE_ID, 1, 15, 65_536, 3, 4);
    let error = inspect_password_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::InvalidLength);

    let input = record_envelope(0, SUITE_ID, 2, 31, 1, 1_024, 1_040);
    let error = inspect_record_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::InvalidLength);
}

#[test]
fn rejects_non_candidate_kdf_profiles() {
    for (memory_kib, time_cost, lanes) in [(65_535, 3, 4), (65_536, 2, 4), (65_536, 3, 3)] {
        let input = password_envelope(0, SUITE_ID, 1, 16, memory_kib, time_cost, lanes);
        let error = inspect_password_envelope_v0alpha1(&input).unwrap_err();
        assert_eq!(error.code(), CryptoErrorCode::KdfParamsRejected);
    }
}

#[test]
fn rejects_zero_or_out_of_range_record_epoch() {
    for epoch in [0, u32::MAX as u64 + 1] {
        let input = record_envelope(0, SUITE_ID, 2, 32, epoch, 1_024, 1_040);
        let error = inspect_record_envelope_v0alpha1(&input).unwrap_err();
        assert_eq!(error.code(), CryptoErrorCode::InvalidLength);
    }
}

#[test]
fn rejects_unapproved_record_bucket() {
    let input = record_envelope(0, SUITE_ID, 2, 32, 1, 2_048, 2_064);
    let error = inspect_record_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::LimitsExceeded);
}

#[test]
fn rejects_encrypted_body_length_that_does_not_match_bucket() {
    let input = record_envelope(0, SUITE_ID, 2, 32, 1, 1_024, 1_039);
    let error = inspect_record_envelope_v0alpha1(&input).unwrap_err();
    assert_eq!(error.code(), CryptoErrorCode::InvalidLength);
}

#[test]
fn accepts_each_approved_record_bucket_with_exact_tag_overhead() {
    for bucket in [1_024, 4_096, 16_384, 61_440] {
        let input = record_envelope(0, SUITE_ID, 2, 32, 1, bucket, bucket as usize + 16);
        assert!(inspect_record_envelope_v0alpha1(&input).is_ok());
    }
}
