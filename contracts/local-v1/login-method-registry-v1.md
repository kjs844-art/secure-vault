# Login Method Registry v1 — 계정별 로그인 출처 기록 계약

작업 ID: `KA-C03`. 이 계약은 Identity Map 도메인의 `ServiceAccount → LoginMethod`
관계 중 로그인 출처 기록만 다룬다. 합성 데이터 전용 로컬 검증 범위이며, 실제
Google·Kakao·Naver·Passkey 연동은 후속 wire 작업까지 금지된다.

## 범위와 비목표

- 로그인 출처의 수동 기록(manual)과 공식 연동(official) 출처를 상태로 구분한다.
- 실제 OAuth/OIDC/Passkey 인증 수행, 로그인 콜백, 세션 관리는 이 계약에 없다.
- Identity Map 전체 화면(`KA-C02`)과 가입 흔적 Discovery Inbox(`KA-C04`)는 별도 작업이다.

## 관계

```text
ServiceAccount ── LoginMethod (Google / Kakao / Naver / Email / Passkey / Manual)
```

## CDDL

`login-method-registry-v1.cddl` 참조. 최상위 배열은 정확히 3개 요소다.

```cddl
login-method-registry-v1 = [  schema_version: 1,  accounts: [* account-login-record-v1]]
```

## AccountLoginRecord v1

| 필드 | CDDL | 제약 |
|---|---|---|
| `account_id` | `bstr .size 16` | 문서 내 고유 |
| `service_name` | `tstr` | 1..=256 UTF-8 바이트 |
| `account_identifier` | `tstr / null` | 최대 256 UTF-8 바이트 |
| `login_methods` | [* login-method-v1] | 1..=16개, `method_id` 문서 내 고유 |
| `notes` | `tstr / null` | 최대 8,192 UTF-8 바이트 |

## LoginMethod v1

| 필드 | CDDL | 제약 |
|---|---|---|
| `method_id` | `bstr .size 16` | 소속 계정 내 고유 |
| `method` | `0..5` | `0`=google, `1`=kakao, `2`=naver, `3`=email, `4`=passkey, `5`=manual |
| `provenance` | `0..2` | `0`=user_recorded, `1`=official_integration, `2`=unknown |
| `recorded_at` | `utc-timestamp / null` | null 금지 |
| `last_observed_at` | `utc-timestamp / null` | `recorded_at` 이후면 `LimitsExceeded` 아님, 검증은 문서 규칙 |
| `status` | `0..2` | `0`=active, `1`=retired, `2`=unknown |
| `notes` | `tstr / null` | 최대 256 UTF-8 바이트 |

## 전역 검증 규칙

- 최상위 배열은 definite-length CBOR 배열이며 정확히 3 필드다.
- 문서의 canonical 인코딩은 최대 60,000 바이트다.
- `accounts`는 최대 128개다. 각 `account_id`는 문서 내 고유이다.
- `login_methods`는 1..=16개다. 각 `method_id`는 소속 계정 내 고유이며, 다른 계정과
  우연히 같아도 문서 수준 오류가 아니다.
- `recorded_at`은 필수다. `last_observed_at`이 존재하면 `recorded_at`과 같거나 이후다.
- `provenance=official_integration`은 실제 연동 승인 전 합성 검증에서는
  `status`와 무관하게 유효하되, 실제 외부 인증 수행을 의미하지 않는다.
- 타임스탬프는 정확히 `YYYY-MM-DDTHH:MM:SSZ`이며 유효한 UTC 달력 값이어야 한다.
- 현재 스키마의 알 수 없는 열거값, dangling 참조, 중복 참조, 비정형 인코딩은 거부된다.
- 미래 스키마 버전은 보존·보고된다(`UpgradeRequired`).

## 합성 데이터 전용 경계

모든 테스트 데이터는 합성 fixture만 사용한다. 실제 서비스명과 유사한 토큰·실제
계정 식별자·실제 인증 프로토콜 흔적을 넣지 않는다.
