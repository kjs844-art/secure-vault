#![allow(
    dead_code,
    reason = "the crate-private synthetic consent boundary is consumed by the later consent UI task"
)]

use crate::LocalVaultError;
use crate::consent::{
    CONSENT_SCHEMA_VERSION, ConsentCenterDocumentV1, ConsentChannelV1, ConsentEvidenceV1,
    ConsentGrantV1, ConsentStateV1, ConsentSubjectV1, EvidenceConfidenceV1, EvidenceSourceV1,
    SubscriptionPlanV1, SubscriptionStatusV1, SubscriptionV1,
};
use crate::ids::EntityIdV1;
use crate::model::UtcTimestampV1;

const FIXTURE_TIMESTAMP: &str = "2026-09-27T00:00:00Z";
const WITHDRAWN_TIMESTAMP: &str = "2026-09-28T00:00:00Z";
const SERVICE_GRANT_ID: EntityIdV1 = EntityIdV1::from_bytes([0xa1; 16]);
const MARKETING_GRANT_ID: EntityIdV1 = EntityIdV1::from_bytes([0xa2; 16]);
const WORKSHOP_SUBSCRIPTION_ID: EntityIdV1 = EntityIdV1::from_bytes([0xb1; 16]);
const PROVIDER_NAME: &str = "Example AI Workshop";
const POLICY_VERSION: &str = "2026-09-27";

pub(crate) fn build_synthetic_consent_document_v1()
-> Result<ConsentCenterDocumentV1, LocalVaultError> {
    Ok(ConsentCenterDocumentV1 {
        schema_version: CONSENT_SCHEMA_VERSION,
        consent_grants: vec![
            ConsentGrantV1 {
                consent_id: SERVICE_GRANT_ID,
                subject: ConsentSubjectV1::Service,
                granted_at: timestamp(FIXTURE_TIMESTAMP)?,
                channel: ConsentChannelV1::InApp,
                policy_version: POLICY_VERSION.to_owned(),
                notification_scope: vec!["transactional".to_owned()],
                state: ConsentStateV1::Granted,
                withdrawn_at: None,
                evidence: ConsentEvidenceV1 {
                    source: EvidenceSourceV1::User,
                    observed_at: Some(timestamp(FIXTURE_TIMESTAMP)?),
                    confidence: EvidenceConfidenceV1::High,
                },
                notes: None,
            },
            ConsentGrantV1 {
                consent_id: MARKETING_GRANT_ID,
                subject: ConsentSubjectV1::Marketing,
                granted_at: timestamp(FIXTURE_TIMESTAMP)?,
                channel: ConsentChannelV1::Email,
                policy_version: POLICY_VERSION.to_owned(),
                notification_scope: vec!["newsletter".to_owned()],
                state: ConsentStateV1::Withdrawn,
                withdrawn_at: Some(timestamp(WITHDRAWN_TIMESTAMP)?),
                evidence: ConsentEvidenceV1 {
                    source: EvidenceSourceV1::ProviderConnector,
                    observed_at: Some(timestamp(WITHDRAWN_TIMESTAMP)?),
                    confidence: EvidenceConfidenceV1::Medium,
                },
                notes: Some("synthetic fixture only".to_owned()),
            },
        ],
        subscriptions: vec![SubscriptionV1 {
            subscription_id: WORKSHOP_SUBSCRIPTION_ID,
            provider_name: PROVIDER_NAME.to_owned(),
            plan: SubscriptionPlanV1::Paid,
            status: SubscriptionStatusV1::Active,
            started_at: Some(timestamp(FIXTURE_TIMESTAMP)?),
            ended_at: None,
            consent_refs: vec![SERVICE_GRANT_ID, MARKETING_GRANT_ID],
            notes: None,
        }],
    })
}

pub(crate) fn encode_synthetic_future_consent_document_v2() -> Vec<u8> {
    use minicbor::Encoder;
    let mut encoder = Encoder::new(Vec::with_capacity(2));
    let _ = encoder.array(1);
    let _ = encoder.u64(CONSENT_SCHEMA_VERSION + 1);
    encoder.into_writer()
}

fn timestamp(value: &str) -> Result<UtcTimestampV1, LocalVaultError> {
    UtcTimestampV1::new(value.to_owned())
}
