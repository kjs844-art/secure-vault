#![allow(
    dead_code,
    reason = "the crate-private login-method boundary is consumed by the later identity map UI task"
)]

use core::convert::Infallible;

use minicbor::{Decoder, Encoder, data::Type, encode::Write};
use std::collections::BTreeSet;

use crate::LocalVaultError;
use crate::ids::EntityIdV1;
use crate::model::UtcTimestampV1;

pub(crate) const LOGIN_METHOD_SCHEMA_VERSION: u64 = 1;
const REGISTRY_FIELD_COUNT: u64 = 3;
const ACCOUNT_FIELD_COUNT: u64 = 5;
const METHOD_FIELD_COUNT: u64 = 7;
const MAX_DOCUMENT_BYTES: usize = 60_000;
const MAX_ACCOUNTS: usize = 128;
const MAX_METHODS_PER_ACCOUNT: usize = 16;
const MIN_METHODS_PER_ACCOUNT: usize = 1;
const MAX_TEXT_BYTES: usize = 256;
const MAX_SERVICE_NAME_BYTES: usize = 256;
const MAX_ACCOUNT_NOTES_BYTES: usize = 8_192;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum LoginMethodKindV1 {
    Google = 0,
    Kakao = 1,
    Naver = 2,
    Email = 3,
    Passkey = 4,
    Manual = 5,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum LoginProvenanceV1 {
    UserRecorded = 0,
    OfficialIntegration = 1,
    Unknown = 2,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum LoginMethodStatusV1 {
    Active = 0,
    Retired = 1,
    Unknown = 2,
}

pub(crate) struct LoginMethodV1 {
    pub method_id: EntityIdV1,
    pub method: LoginMethodKindV1,
    pub provenance: LoginProvenanceV1,
    pub recorded_at: UtcTimestampV1,
    pub last_observed_at: Option<UtcTimestampV1>,
    pub status: LoginMethodStatusV1,
    pub notes: Option<String>,
}

pub(crate) struct AccountLoginRecordV1 {
    pub account_id: EntityIdV1,
    pub service_name: String,
    pub account_identifier: Option<String>,
    pub login_methods: Vec<LoginMethodV1>,
    pub notes: Option<String>,
}

pub(crate) struct LoginMethodRegistryV1 {
    pub schema_version: u64,
    pub accounts: Vec<AccountLoginRecordV1>,
}

pub(crate) enum DecodedLoginMethodRegistry {
    Current(LoginMethodRegistryV1),
    UpgradeRequired { version: u64 },
}

impl LoginMethodRegistryV1 {
    pub(crate) fn validate(&self) -> Result<(), LocalVaultError> {
        if self.schema_version != LOGIN_METHOD_SCHEMA_VERSION {
            return Err(LocalVaultError::InvalidItem);
        }
        if self.accounts.len() > MAX_ACCOUNTS {
            return Err(LocalVaultError::LimitsExceeded);
        }
        let mut account_ids = BTreeSet::new();
        for account in &self.accounts {
            if !account_ids.insert(account.account_id.as_bytes()) {
                return Err(LocalVaultError::InvalidItem);
            }
            validate_account(account)?;
        }
        Ok(())
    }
}

fn validate_account(account: &AccountLoginRecordV1) -> Result<(), LocalVaultError> {
    require_nonempty(&account.service_name)?;
    require_max_bytes(&account.service_name, MAX_SERVICE_NAME_BYTES)?;
    require_optional_max_bytes(account.account_identifier.as_deref(), MAX_TEXT_BYTES)?;
    require_optional_max_bytes(account.notes.as_deref(), MAX_ACCOUNT_NOTES_BYTES)?;
    if account.login_methods.len() < MIN_METHODS_PER_ACCOUNT
        || account.login_methods.len() > MAX_METHODS_PER_ACCOUNT
    {
        return Err(LocalVaultError::LimitsExceeded);
    }
    let mut method_ids = BTreeSet::new();
    for method in &account.login_methods {
        if !method_ids.insert(method.method_id.as_bytes()) {
            return Err(LocalVaultError::InvalidItem);
        }
        require_optional_max_bytes(method.notes.as_deref(), MAX_TEXT_BYTES)?;
        if let Some(last_observed) = method.last_observed_at.as_ref()
            && last_observed.as_str() < method.recorded_at.as_str()
        {
            return Err(LocalVaultError::InvalidItem);
        }
    }
    Ok(())
}

fn require_nonempty(value: &str) -> Result<(), LocalVaultError> {
    if value.is_empty() {
        return Err(LocalVaultError::InvalidItem);
    }
    Ok(())
}

fn require_max_bytes(value: &str, max: usize) -> Result<(), LocalVaultError> {
    if value.len() > max {
        return Err(LocalVaultError::LimitsExceeded);
    }
    Ok(())
}

fn require_optional_max_bytes(value: Option<&str>, max: usize) -> Result<(), LocalVaultError> {
    match value {
        Some(text) => require_max_bytes(text, max),
        None => Ok(()),
    }
}

pub(crate) fn encode_login_method_registry(
    registry: &LoginMethodRegistryV1,
) -> Result<Vec<u8>, LocalVaultError> {
    registry.validate()?;
    let mut encoded = encode_registry_into(Vec::with_capacity(4_096), registry)?;
    if encoded.len() > MAX_DOCUMENT_BYTES {
        encoded.clear();
        return Err(LocalVaultError::LimitsExceeded);
    }
    Ok(encoded)
}

fn encode_registry_into<W: Write>(
    writer: W,
    registry: &LoginMethodRegistryV1,
) -> Result<W, LocalVaultError> {
    let mut encoder = Encoder::new(writer);
    encoder.array(REGISTRY_FIELD_COUNT).map_err(encode_error)?;
    encoder.u64(registry.schema_version).map_err(encode_error)?;
    encoder
        .array(length_as_u64(registry.accounts.len())?)
        .map_err(encode_error)?;
    for account in &registry.accounts {
        encode_account(&mut encoder, account)?;
    }
    Ok(encoder.into_writer())
}

fn encode_account<W: Write>(
    encoder: &mut Encoder<W>,
    account: &AccountLoginRecordV1,
) -> Result<(), LocalVaultError> {
    encoder.array(ACCOUNT_FIELD_COUNT).map_err(encode_error)?;
    encoder
        .bytes(account.account_id.as_bytes())
        .map_err(encode_error)?;
    encoder.str(&account.service_name).map_err(encode_error)?;
    encode_optional_text(encoder, account.account_identifier.as_deref())?;
    encoder
        .array(length_as_u64(account.login_methods.len())?)
        .map_err(encode_error)?;
    for method in &account.login_methods {
        encode_method(encoder, method)?;
    }
    encode_optional_text(encoder, account.notes.as_deref())?;
    Ok(())
}

fn encode_method<W: Write>(
    encoder: &mut Encoder<W>,
    method: &LoginMethodV1,
) -> Result<(), LocalVaultError> {
    encoder.array(METHOD_FIELD_COUNT).map_err(encode_error)?;
    encoder
        .bytes(method.method_id.as_bytes())
        .map_err(encode_error)?;
    encoder.u64(method.method as u64).map_err(encode_error)?;
    encoder
        .u64(method.provenance as u64)
        .map_err(encode_error)?;
    encoder
        .str(method.recorded_at.as_str())
        .map_err(encode_error)?;
    encode_optional_timestamp(encoder, method.last_observed_at.as_ref())?;
    encoder.u64(method.status as u64).map_err(encode_error)?;
    encode_optional_text(encoder, method.notes.as_deref())?;
    Ok(())
}

fn encode_optional_text<W: Write>(
    encoder: &mut Encoder<W>,
    value: Option<&str>,
) -> Result<(), LocalVaultError> {
    match value {
        Some(text) => {
            encoder.str(text).map_err(encode_error)?;
        }
        None => {
            encoder.null().map_err(encode_error)?;
        }
    }
    Ok(())
}

fn encode_optional_timestamp<W: Write>(
    encoder: &mut Encoder<W>,
    value: Option<&UtcTimestampV1>,
) -> Result<(), LocalVaultError> {
    match value {
        Some(timestamp) => {
            encoder.str(timestamp.as_str()).map_err(encode_error)?;
        }
        None => {
            encoder.null().map_err(encode_error)?;
        }
    }
    Ok(())
}

pub(crate) fn decode_login_method_registry(
    input: &[u8],
) -> Result<DecodedLoginMethodRegistry, LocalVaultError> {
    if input.len() > MAX_DOCUMENT_BYTES {
        return Err(LocalVaultError::LimitsExceeded);
    }
    let mut decoder = Decoder::new(input);
    let field_count = decoder
        .array()
        .map_err(decode_error)?
        .ok_or(LocalVaultError::NonCanonicalEncoding)?;
    if field_count == 0 {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }
    let version = decoder.u64().map_err(decode_error)?;
    if version == 0 {
        return Err(LocalVaultError::InvalidItem);
    }
    if version > LOGIN_METHOD_SCHEMA_VERSION {
        if decoder.position() != input.len() {
            return Err(LocalVaultError::NonCanonicalEncoding);
        }
        return Ok(DecodedLoginMethodRegistry::UpgradeRequired { version });
    }
    if field_count != REGISTRY_FIELD_COUNT {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }
    let registry = decode_registry_fields(&mut decoder)?;
    if decoder.position() != input.len() {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }
    registry.validate()?;
    let comparator = encode_registry_into(CanonicalComparator::new(input), &registry)?;
    if !comparator.is_exact_match() {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }
    Ok(DecodedLoginMethodRegistry::Current(registry))
}

fn decode_registry_fields(
    decoder: &mut Decoder<'_>,
) -> Result<LoginMethodRegistryV1, LocalVaultError> {
    let accounts = decode_bounded_array(decoder, MAX_ACCOUNTS, decode_account)?;
    Ok(LoginMethodRegistryV1 {
        schema_version: LOGIN_METHOD_SCHEMA_VERSION,
        accounts,
    })
}

fn decode_account(decoder: &mut Decoder<'_>) -> Result<AccountLoginRecordV1, LocalVaultError> {
    require_array(decoder, ACCOUNT_FIELD_COUNT)?;
    let account_id = decode_entity(decoder)?;
    let service_name = decode_text(decoder)?;
    let account_identifier = decode_optional_text(decoder)?;
    let login_methods = decode_bounded_array(decoder, MAX_METHODS_PER_ACCOUNT, decode_method)?;
    let notes = decode_optional_text(decoder)?;
    Ok(AccountLoginRecordV1 {
        account_id,
        service_name,
        account_identifier,
        login_methods,
        notes,
    })
}

fn decode_method(decoder: &mut Decoder<'_>) -> Result<LoginMethodV1, LocalVaultError> {
    require_array(decoder, METHOD_FIELD_COUNT)?;
    let method_id = decode_entity(decoder)?;
    let method = match decoder.u64().map_err(decode_error)? {
        0 => LoginMethodKindV1::Google,
        1 => LoginMethodKindV1::Kakao,
        2 => LoginMethodKindV1::Naver,
        3 => LoginMethodKindV1::Email,
        4 => LoginMethodKindV1::Passkey,
        5 => LoginMethodKindV1::Manual,
        _ => return Err(LocalVaultError::InvalidItem),
    };
    let provenance = match decoder.u64().map_err(decode_error)? {
        0 => LoginProvenanceV1::UserRecorded,
        1 => LoginProvenanceV1::OfficialIntegration,
        2 => LoginProvenanceV1::Unknown,
        _ => return Err(LocalVaultError::InvalidItem),
    };
    let recorded_at = decode_timestamp(decoder)?;
    let last_observed_at = decode_optional_timestamp(decoder)?;
    let status = match decoder.u64().map_err(decode_error)? {
        0 => LoginMethodStatusV1::Active,
        1 => LoginMethodStatusV1::Retired,
        2 => LoginMethodStatusV1::Unknown,
        _ => return Err(LocalVaultError::InvalidItem),
    };
    let notes = decode_optional_text(decoder)?;
    Ok(LoginMethodV1 {
        method_id,
        method,
        provenance,
        recorded_at,
        last_observed_at,
        status,
        notes,
    })
}

fn decode_bounded_array<T>(
    decoder: &mut Decoder<'_>,
    max: usize,
    mut element: impl FnMut(&mut Decoder<'_>) -> Result<T, LocalVaultError>,
) -> Result<Vec<T>, LocalVaultError> {
    let length = decoder
        .array()
        .map_err(decode_error)?
        .ok_or(LocalVaultError::NonCanonicalEncoding)? as usize;
    if length > max {
        return Err(LocalVaultError::LimitsExceeded);
    }
    let mut values = Vec::with_capacity(length);
    for _ in 0..length {
        values.push(element(decoder)?);
    }
    Ok(values)
}

fn decode_entity(decoder: &mut Decoder<'_>) -> Result<EntityIdV1, LocalVaultError> {
    let bytes = decoder.bytes().map_err(decode_error)?;
    let bytes: [u8; 16] = bytes.try_into().map_err(|_| LocalVaultError::InvalidItem)?;
    Ok(EntityIdV1::from_bytes(bytes))
}

fn decode_text(decoder: &mut Decoder<'_>) -> Result<String, LocalVaultError> {
    decoder.str().map(str::to_owned).map_err(decode_error)
}

fn decode_optional_text(decoder: &mut Decoder<'_>) -> Result<Option<String>, LocalVaultError> {
    if decode_null(decoder)? {
        return Ok(None);
    }
    decode_text(decoder).map(Some)
}

fn decode_timestamp(decoder: &mut Decoder<'_>) -> Result<UtcTimestampV1, LocalVaultError> {
    let value = decode_text(decoder)?;
    UtcTimestampV1::new(value)
}

fn decode_optional_timestamp(
    decoder: &mut Decoder<'_>,
) -> Result<Option<UtcTimestampV1>, LocalVaultError> {
    if decode_null(decoder)? {
        return Ok(None);
    }
    decode_timestamp(decoder).map(Some)
}

fn decode_null(decoder: &mut Decoder<'_>) -> Result<bool, LocalVaultError> {
    match decoder.datatype().map_err(decode_error)? {
        Type::Null => {
            decoder.null().map_err(decode_error)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn require_array(decoder: &mut Decoder<'_>, expected: u64) -> Result<(), LocalVaultError> {
    let actual = decoder
        .array()
        .map_err(decode_error)?
        .ok_or(LocalVaultError::NonCanonicalEncoding)?;
    if actual != expected {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }
    Ok(())
}

fn length_as_u64(length: usize) -> Result<u64, LocalVaultError> {
    u64::try_from(length).map_err(|_| LocalVaultError::LimitsExceeded)
}

fn encode_error<E>(_: minicbor::encode::Error<E>) -> LocalVaultError {
    LocalVaultError::NonCanonicalEncoding
}

fn decode_error(_: minicbor::decode::Error) -> LocalVaultError {
    LocalVaultError::NonCanonicalEncoding
}

struct CanonicalComparator<'a> {
    expected: &'a [u8],
    position: usize,
    matches: bool,
}

impl<'a> CanonicalComparator<'a> {
    const fn new(expected: &'a [u8]) -> Self {
        Self {
            expected,
            position: 0,
            matches: true,
        }
    }

    fn is_exact_match(&self) -> bool {
        self.matches && self.position == self.expected.len()
    }
}

impl Write for CanonicalComparator<'_> {
    type Error = Infallible;

    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error> {
        let Some(end) = self.position.checked_add(bytes.len()) else {
            self.matches = false;
            return Ok(());
        };
        if self.expected.get(self.position..end) != Some(bytes) {
            self.matches = false;
        }
        self.position = end;
        Ok(())
    }
}
