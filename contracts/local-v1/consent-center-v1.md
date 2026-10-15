# Consent Center v1 — ConsentGrant·Subscription domain contract

작업 ID: `KA-D01`. 이 계약은 합성 데이터 전용 로컬 검증 범위의
상태·미래 버전·검증 규칙을 정의한다. 실제 외부 구독·결제·동의 철회 연동은 포함하지 않는다.

## 범위와 비목표

- Consent Center의 첫 도메인 계약이다. KeyAtlas 자체 결제와 외부 서비스 구독을 혼동하지 않는다.
- 이 계약은 상태 계약(state contract)만 정의한다. 동의 철회·수신 거부의 실제 외부 동작
  어댑터는 후속 `KA-D04` 이전까지 구현·노출하지 않는다.
- 마케팅·제3자 제공·SMS·Push·OAuth scope의 화면 표시는 `KA-D02`, 외부 구독 기록은 `KA-D03` 범위다.

## 관계

```text
ConsentGrant ── Evidence(source, observed_at, confidence)
Subscription(external provider) ── ConsentGrant
```

## CDDL

`consent-center-v1.cddl` 참조. 최상위 배열은 정확히 3개 요소다.

```cddl
consent-center-v1 = [  schema_version: 1,  consent_grants: [* consent-grant-v1],  subscriptions: [* subscription-v1]]
```

## ConsentGrant v1

| 필드 | CDDL | 제약 |
|---|---|---|
| `consent_id` | `bstr .size 16` | 문서 내 고유 |
| `subject` | `0..2` | `0`=service, `1`=third_party_provider, `2`=marketing` |
| `granted_at` | `utc-timestamp / null` | null 금지 |
| `channel` | `0..3` | `0`=email, `1`=sms, `2`=push, `3`=in_app` |
| `policy_version` | `tstr` | 1..=32 UTF-8 바이트, 문서 내 고유 |
| `notification_scope` | `[* tstr]` | 최대 64개, 각 1..=256 바이트 |
| `state` | `0..1` | `0`=granted, `1`=withdrawn` |
| `withdrawn_at` | `utc-timestamp / null` | `state=1`일 때만 존재 |
| `evidence` | `evidence-v1` | 아래 참조 |
| `notes` | `tstr / null` | 최대 256 UTF-8 바이트 |

`evidence-v1 = [  source: 0..2,  observed_at: utc-timestamp / null,  confidence: 0..2]`

- `source`: `0`=user, `1`=provider_connector, `2`=unknown`
- `confidence`: `0`=high, `1`=medium, `2`=low`
- `state=withdrawn`이면 `evidence.source`는 `provider_connector` 또는 `unknown`이어야 한다.

## Subscription v1

| 필드 | CDDL | 제약 |
|---|---|---|
| `subscription_id` | `bstr .size 16` | 문서 내 고유 |
| `provider_name` | `tstr` | 1..=256 UTF-8 바이트 |
| `plan` | `0..2` | `0`=free, `1`=paid, `2`=trial` |
| `status` | `0..4` | `0`=active, `1`=renewal, `2`=cancelled, `3`=expired, `4`=unknown` |
| `started_at` | `utc-timestamp / null` | — |
| `ended_at` | `utc-timestamp / null` | — |
| `consent_refs` | `[* bstr .size 16]` | 문서 내 ConsentGrant 참조. 고유. 최대 128개 |
| `notes` | `tstr / null` | 최대 256 UTF-8 바이트 |

## 전역 검증 규칙

- 최상위 배열은 definite-length CBOR 배열이며 정확히 3 필드다.
- 문서의 canonical 인코딩은 최대 60,000 바이트다.
- `consent_grants`는 최대 128개, `subscriptions`는 최대 128개다.
- 모든 `consent_id`, `subscription_id`는 문서 내 고유이다.
- `consent_refs`의 모든 참조는 문서 내 ConsentGrant 존재를 가리킨다. 참조는 고유하다.
- 타임스탬프는 정확히 `YYYY-MM-DDTHH:MM:SSZ`이며 유효한 UTC 달력 값이어야 한다.
- 현재 스키마의 알 수 없는 열거값, dangling 참조, 중복 참조, 비정형 인코딩은 거부된다.
- 미래 스키마 버전은 보존·보고된다(historical evidence `validate_conservation`과 동일 계약).

## 합성 데이터 전용 경계

이 계약은 외부 구독·결제·마케팅 서비스와 어떤 연동도 하지 않는다. 모든 테스트 데이터는
`tests/fixtures/synthetic/`의 합성 데이터만 사용한다. 실제 서비스 이름과 유사한 토큰,
실제 결제 수단, 실제 동의 문구를 넣지 않는다.
