#![allow(
    dead_code,
    reason = "the crate-private consent boundary is consumed by the later consent UI task"
)]

use core::convert::Infallible;
use std::collections::BTreeSet;

use minicbor::{Decoder, Encoder, data::Type, encode::Write};

use crate::LocalVaultError;
use crate::ids::EntityIdV1;
use crate::model::UtcTimestampV1;

pub(crate) const CONSENT_SCHEMA_VERSION: u64 = 1;
const CONSENT_FIELD_COUNT: u64 = 3;
const CONSENT_GRANT_FIELD_COUNT: u64 = 10;
const EVIDENCE_FIELD_COUNT: u64 = 3;
const SUBSCRIPTION_FIELD_COUNT: u64 = 9;
const MAX_DOCUMENT_BYTES: usize = 60_000;
const MAX_CONSENT_GRANTS: usize = 128;
const MAX_SUBSCRIPTIONS: usize = 128;
const MAX_CONSENT_REFS: usize = 128;
const MAX_SCOPES: usize = 64;
const MAX_TEXT_BYTES: usize = 256;
const MAX_POLICY_VERSION_BYTES: usize = 32;
const MAX_SCOPE_BYTES: usize = 256;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum ConsentSubjectV1 {
    Service = 0,
    ThirdPartyProvider = 1,
    Marketing = 2,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum ConsentChannelV1 {
    Email = 0,
    Sms = 1,
    Push = 2,
    InApp = 3,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum ConsentStateV1 {
    Granted = 0,
    Withdrawn = 1,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum EvidenceSourceV1 {
    User = 0,
    ProviderConnector = 1,
    Unknown = 2,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum EvidenceConfidenceV1 {
    High = 0,
    Medium = 1,
    Low = 2,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum SubscriptionPlanV1 {
    Free = 0,
    Paid = 1,
    Trial = 2,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum SubscriptionStatusV1 {
    Active = 0,
    Renewal = 1,
    Cancelled = 2,
    Expired = 3,
    Unknown = 4,
}

pub(crate) struct ConsentEvidenceV1 {
    pub source: EvidenceSourceV1,
    pub observed_at: Option<UtcTimestampV1>,
    pub confidence: EvidenceConfidenceV1,
}

pub(crate) struct ConsentGrantV1 {
    pub consent_id: EntityIdV1,
    pub subject: ConsentSubjectV1,
    pub granted_at: UtcTimestampV1,
    pub channel: ConsentChannelV1,
    pub policy_version: String,
    pub notification_scope: Vec<String>,
    pub state: ConsentStateV1,
    pub withdrawn_at: Option<UtcTimestampV1>,
    pub evidence: ConsentEvidenceV1,
    pub notes: Option<String>,
}

pub(crate) struct SubscriptionV1 {
    pub subscription_id: EntityIdV1,
    pub provider_name: String,
    pub plan: SubscriptionPlanV1,
    pub status: SubscriptionStatusV1,
    pub started_at: Option<UtcTimestampV1>,
    pub ended_at: Option<UtcTimestampV1>,
    pub consent_refs: Vec<EntityIdV1>,
    pub notes: Option<String>,
}

pub(crate) struct ConsentCenterDocumentV1 {
    pub schema_version: u64,
    pub consent_grants: Vec<ConsentGrantV1>,
    pub subscriptions: Vec<SubscriptionV1>,
}

pub(crate) enum DecodedConsentCenter {
    Current(ConsentCenterDocumentV1),
    UpgradeRequired { version: u64 },
}

impl ConsentCenterDocumentV1 {
    pub(crate) fn validate(&self) -> Result<(), LocalVaultError> {
        if self.schema_version != CONSENT_SCHEMA_VERSION {
            return Err(LocalVaultError::InvalidItem);
        }
        if self.consent_grants.len() > MAX_CONSENT_GRANTS
            || self.subscriptions.len() > MAX_SUBSCRIPTIONS
        {
            return Err(LocalVaultError::LimitsExceeded);
        }
        let mut consent_ids = BTreeSet::new();
        for grant in &self.consent_grants {
            if !consent_ids.insert(grant.consent_id.as_bytes()) {
                return Err(LocalVaultError::InvalidItem);
            }
            validate_grant(grant)?;
        }
        let mut subscription_ids = BTreeSet::new();
        for subscription in &self.subscriptions {
            if !subscription_ids.insert(subscription.subscription_id.as_bytes()) {
                return Err(LocalVaultError::InvalidItem);
            }
            validate_subscription(subscription, &consent_ids)?;
        }
        Ok(())
    }
}

fn validate_grant(grant: &ConsentGrantV1) -> Result<(), LocalVaultError> {
    require_nonempty(&grant.policy_version)?;
    require_max_bytes(&grant.policy_version, MAX_POLICY_VERSION_BYTES)?;
    require_optional_max_bytes(grant.notes.as_deref(), MAX_TEXT_BYTES)?;
    if grant.notification_scope.len() > MAX_SCOPES {
        return Err(LocalVaultError::LimitsExceeded);
    }
    for scope in &grant.notification_scope {
        require_nonempty(scope)?;
        require_max_bytes(scope, MAX_SCOPE_BYTES)?;
    }
    match grant.state {
        ConsentStateV1::Granted => {
            if grant.withdrawn_at.is_some() {
                return Err(LocalVaultError::InvalidItem);
            }
        }
        ConsentStateV1::Withdrawn => {
            if grant.withdrawn_at.is_none() {
                return Err(LocalVaultError::InvalidItem);
            }
            if grant.evidence.source == EvidenceSourceV1::User {
                return Err(LocalVaultError::InvalidItem);
            }
        }
    }
    Ok(())
}

fn validate_subscription(
    subscription: &SubscriptionV1,
    consent_ids: &BTreeSet<&[u8; 16]>,
) -> Result<(), LocalVaultError> {
    require_nonempty(&subscription.provider_name)?;
    require_max_bytes(&subscription.provider_name, MAX_TEXT_BYTES)?;
    require_optional_max_bytes(subscription.notes.as_deref(), MAX_TEXT_BYTES)?;
    if subscription.consent_refs.len() > MAX_CONSENT_REFS {
        return Err(LocalVaultError::LimitsExceeded);
    }
    let mut references = BTreeSet::new();
    for reference in &subscription.consent_refs {
        if !consent_ids.contains(reference.as_bytes()) || !references.insert(reference.as_bytes()) {
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

pub(crate) fn encode_consent_center(
    document: &ConsentCenterDocumentV1,
) -> Result<Vec<u8>, LocalVaultError> {
    document.validate()?;
    let mut encoded = encode_document_into(Vec::with_capacity(4_096), document)?;
    if encoded.len() > MAX_DOCUMENT_BYTES {
        encoded.clear();
        return Err(LocalVaultError::LimitsExceeded);
    }
    Ok(encoded)
}

fn encode_document_into<W: Write>(
    writer: W,
    document: &ConsentCenterDocumentV1,
) -> Result<W, LocalVaultError> {
    let mut encoder = Encoder::new(writer);
    encoder.array(CONSENT_FIELD_COUNT).map_err(encode_error)?;
    encoder.u64(document.schema_version).map_err(encode_error)?;
    encoder
        .array(length_as_u64(document.consent_grants.len())?)
        .map_err(encode_error)?;
    for grant in &document.consent_grants {
        encode_grant(&mut encoder, grant)?;
    }
    encoder
        .array(length_as_u64(document.subscriptions.len())?)
        .map_err(encode_error)?;
    for subscription in &document.subscriptions {
        encode_subscription(&mut encoder, subscription)?;
    }
    Ok(encoder.into_writer())
}

fn encode_grant<W: Write>(
    encoder: &mut Encoder<W>,
    grant: &ConsentGrantV1,
) -> Result<(), LocalVaultError> {
    encoder
        .array(CONSENT_GRANT_FIELD_COUNT)
        .map_err(encode_error)?;
    encoder
        .bytes(grant.consent_id.as_bytes())
        .map_err(encode_error)?;
    encoder.u64(grant.subject as u64).map_err(encode_error)?;
    encoder
        .str(grant.granted_at.as_str())
        .map_err(encode_error)?;
    encoder.u64(grant.channel as u64).map_err(encode_error)?;
    encoder.str(&grant.policy_version).map_err(encode_error)?;
    encoder
        .array(length_as_u64(grant.notification_scope.len())?)
        .map_err(encode_error)?;
    for scope in &grant.notification_scope {
        encoder.str(scope).map_err(encode_error)?;
    }
    encoder.u64(grant.state as u64).map_err(encode_error)?;
    encode_optional_timestamp(encoder, grant.withdrawn_at.as_ref())?;
    encode_evidence(encoder, &grant.evidence)?;
    encode_optional_text(encoder, grant.notes.as_deref())?;
    Ok(())
}

fn encode_evidence<W: Write>(
    encoder: &mut Encoder<W>,
    evidence: &ConsentEvidenceV1,
) -> Result<(), LocalVaultError> {
    encoder.array(EVIDENCE_FIELD_COUNT).map_err(encode_error)?;
    encoder.u64(evidence.source as u64).map_err(encode_error)?;
    encode_optional_timestamp(encoder, evidence.observed_at.as_ref())?;
    encoder
        .u64(evidence.confidence as u64)
        .map_err(encode_error)?;
    Ok(())
}

fn encode_subscription<W: Write>(
    encoder: &mut Encoder<W>,
    subscription: &SubscriptionV1,
) -> Result<(), LocalVaultError> {
    encoder
        .array(SUBSCRIPTION_FIELD_COUNT)
        .map_err(encode_error)?;
    encoder
        .bytes(subscription.subscription_id.as_bytes())
        .map_err(encode_error)?;
    encoder
        .str(&subscription.provider_name)
        .map_err(encode_error)?;
    encoder
        .u64(subscription.plan as u64)
        .map_err(encode_error)?;
    encoder
        .u64(subscription.status as u64)
        .map_err(encode_error)?;
    encode_optional_timestamp(encoder, subscription.started_at.as_ref())?;
    encode_optional_timestamp(encoder, subscription.ended_at.as_ref())?;
    encoder
        .array(length_as_u64(subscription.consent_refs.len())?)
        .map_err(encode_error)?;
    for reference in &subscription.consent_refs {
        encoder.bytes(reference.as_bytes()).map_err(encode_error)?;
    }
    encode_optional_text(encoder, subscription.notes.as_deref())?;
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

pub(crate) fn decode_consent_center(input: &[u8]) -> Result<DecodedConsentCenter, LocalVaultError> {
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
    if version > CONSENT_SCHEMA_VERSION {
        if decoder.position() != input.len() {
            return Err(LocalVaultError::NonCanonicalEncoding);
        }
        return Ok(DecodedConsentCenter::UpgradeRequired { version });
    }
    if field_count != CONSENT_FIELD_COUNT {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }
    let document = decode_document_fields(&mut decoder)?;
    if decoder.position() != input.len() {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }
    document.validate()?;
    let comparator = encode_document_into(CanonicalComparator::new(input), &document)?;
    if !comparator.is_exact_match() {
        return Err(LocalVaultError::NonCanonicalEncoding);
    }
    Ok(DecodedConsentCenter::Current(document))
}

fn decode_document_fields(
    decoder: &mut Decoder<'_>,
) -> Result<ConsentCenterDocumentV1, LocalVaultError> {
    let consent_grants = decode_bounded_array(decoder, MAX_CONSENT_GRANTS, decode_grant)?;
    let subscriptions = decode_bounded_array(decoder, MAX_SUBSCRIPTIONS, decode_subscription)?;
    Ok(ConsentCenterDocumentV1 {
        schema_version: CONSENT_SCHEMA_VERSION,
        consent_grants,
        subscriptions,
    })
}

fn decode_grant(decoder: &mut Decoder<'_>) -> Result<ConsentGrantV1, LocalVaultError> {
    require_array(decoder, CONSENT_GRANT_FIELD_COUNT)?;
    let consent_id = decode_entity(decoder)?;
    let subject = decode_subject(decoder)?;
    let granted_at = decode_timestamp(decoder)?;
    let channel = decode_channel(decoder)?;
    let policy_version = decode_text(decoder)?;
    let notification_scope = decode_text_array(decoder, MAX_SCOPES)?;
    let state = decode_state(decoder)?;
    let withdrawn_at = decode_optional_timestamp(decoder)?;
    let evidence = decode_evidence(decoder)?;
    let notes = decode_optional_text(decoder)?;
    Ok(ConsentGrantV1 {
        consent_id,
        subject,
        granted_at,
        channel,
        policy_version,
        notification_scope,
        state,
        withdrawn_at,
        evidence,
        notes,
    })
}

fn decode_evidence(decoder: &mut Decoder<'_>) -> Result<ConsentEvidenceV1, LocalVaultError> {
    require_array(decoder, EVIDENCE_FIELD_COUNT)?;
    let source = match decoder.u64().map_err(decode_error)? {
        0 => EvidenceSourceV1::User,
        1 => EvidenceSourceV1::ProviderConnector,
        2 => EvidenceSourceV1::Unknown,
        _ => return Err(LocalVaultError::InvalidItem),
    };
    let observed_at = decode_optional_timestamp(decoder)?;
    let confidence = match decoder.u64().map_err(decode_error)? {
        0 => EvidenceConfidenceV1::High,
        1 => EvidenceConfidenceV1::Medium,
        2 => EvidenceConfidenceV1::Low,
        _ => return Err(LocalVaultError::InvalidItem),
    };
    Ok(ConsentEvidenceV1 {
        source,
        observed_at,
        confidence,
    })
}

fn decode_subscription(decoder: &mut Decoder<'_>) -> Result<SubscriptionV1, LocalVaultError> {
    require_array(decoder, SUBSCRIPTION_FIELD_COUNT)?;
    let subscription_id = decode_entity(decoder)?;
    let provider_name = decode_text(decoder)?;
    let plan = match decoder.u64().map_err(decode_error)? {
        0 => SubscriptionPlanV1::Free,
        1 => SubscriptionPlanV1::Paid,
        2 => SubscriptionPlanV1::Trial,
        _ => return Err(LocalVaultError::InvalidItem),
    };
    let status = match decoder.u64().map_err(decode_error)? {
        0 => SubscriptionStatusV1::Active,
        1 => SubscriptionStatusV1::Renewal,
        2 => SubscriptionStatusV1::Cancelled,
        3 => SubscriptionStatusV1::Expired,
        4 => SubscriptionStatusV1::Unknown,
        _ => return Err(LocalVaultError::InvalidItem),
    };
    let started_at = decode_optional_timestamp(decoder)?;
    let ended_at = decode_optional_timestamp(decoder)?;
    let consent_refs = decode_bounded_array(decoder, MAX_CONSENT_REFS, decode_entity)?;
    let notes = decode_optional_text(decoder)?;
    Ok(SubscriptionV1 {
        subscription_id,
        provider_name,
        plan,
        status,
        started_at,
        ended_at,
        consent_refs,
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

fn decode_subject(decoder: &mut Decoder<'_>) -> Result<ConsentSubjectV1, LocalVaultError> {
    match decoder.u64().map_err(decode_error)? {
        0 => Ok(ConsentSubjectV1::Service),
        1 => Ok(ConsentSubjectV1::ThirdPartyProvider),
        2 => Ok(ConsentSubjectV1::Marketing),
        _ => Err(LocalVaultError::InvalidItem),
    }
}

fn decode_channel(decoder: &mut Decoder<'_>) -> Result<ConsentChannelV1, LocalVaultError> {
    match decoder.u64().map_err(decode_error)? {
        0 => Ok(ConsentChannelV1::Email),
        1 => Ok(ConsentChannelV1::Sms),
        2 => Ok(ConsentChannelV1::Push),
        3 => Ok(ConsentChannelV1::InApp),
        _ => Err(LocalVaultError::InvalidItem),
    }
}

fn decode_state(decoder: &mut Decoder<'_>) -> Result<ConsentStateV1, LocalVaultError> {
    match decoder.u64().map_err(decode_error)? {
        0 => Ok(ConsentStateV1::Granted),
        1 => Ok(ConsentStateV1::Withdrawn),
        _ => Err(LocalVaultError::InvalidItem),
    }
}

fn decode_text_array(
    decoder: &mut Decoder<'_>,
    max: usize,
) -> Result<Vec<String>, LocalVaultError> {
    decode_bounded_array(decoder, max, decode_text)
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

fn decode_error(error: minicbor::decode::Error) -> LocalVaultError {
    let _ = error;
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
