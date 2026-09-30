#![allow(
    dead_code,
    reason = "the crate-private synthetic login-method boundary is consumed by the later identity map UI task"
)]

use crate::LocalVaultError;
use crate::ids::EntityIdV1;
use crate::login_method::{
    AccountLoginRecordV1, LOGIN_METHOD_SCHEMA_VERSION, LoginMethodKindV1, LoginMethodRegistryV1,
    LoginMethodStatusV1, LoginMethodV1, LoginProvenanceV1,
};
use crate::model::UtcTimestampV1;

const RECORDED_AT: &str = "2026-09-30T00:00:00Z";
const OBSERVED_AT: &str = "2026-09-30T01:00:00Z";
const SERVICE_ACCOUNT_ID: EntityIdV1 = EntityIdV1::from_bytes([0xc1; 16]);
const GOOGLE_METHOD_ID: EntityIdV1 = EntityIdV1::from_bytes([0xd1; 16]);
const EMAIL_METHOD_ID: EntityIdV1 = EntityIdV1::from_bytes([0xd2; 16]);
const SERVICE_NAME: &str = "Example AI Workshop";
const ACCOUNT_IDENTIFIER: &str = "demo-user@example.invalid";

pub(crate) fn build_synthetic_login_method_registry_v1()
-> Result<LoginMethodRegistryV1, LocalVaultError> {
    Ok(LoginMethodRegistryV1 {
        schema_version: LOGIN_METHOD_SCHEMA_VERSION,
        accounts: vec![AccountLoginRecordV1 {
            account_id: SERVICE_ACCOUNT_ID,
            service_name: SERVICE_NAME.to_owned(),
            account_identifier: Some(ACCOUNT_IDENTIFIER.to_owned()),
            login_methods: vec![
                LoginMethodV1 {
                    method_id: GOOGLE_METHOD_ID,
                    method: LoginMethodKindV1::Google,
                    provenance: LoginProvenanceV1::OfficialIntegration,
                    recorded_at: timestamp(RECORDED_AT)?,
                    last_observed_at: Some(timestamp(OBSERVED_AT)?),
                    status: LoginMethodStatusV1::Active,
                    notes: None,
                },
                LoginMethodV1 {
                    method_id: EMAIL_METHOD_ID,
                    method: LoginMethodKindV1::Email,
                    provenance: LoginProvenanceV1::UserRecorded,
                    recorded_at: timestamp(RECORDED_AT)?,
                    last_observed_at: None,
                    status: LoginMethodStatusV1::Retired,
                    notes: Some("synthetic fixture only".to_owned()),
                },
            ],
            notes: None,
        }],
    })
}

pub(crate) fn encode_synthetic_future_login_registry_v2() -> Vec<u8> {
    use minicbor::Encoder;
    let mut encoder = Encoder::new(Vec::with_capacity(2));
    let _ = encoder.array(1);
    let _ = encoder.u64(LOGIN_METHOD_SCHEMA_VERSION + 1);
    encoder.into_writer()
}

fn timestamp(value: &str) -> Result<UtcTimestampV1, LocalVaultError> {
    UtcTimestampV1::new(value.to_owned())
}
