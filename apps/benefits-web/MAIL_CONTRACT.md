# Gmail 후보 처리 계약 — 합성 데이터 단계

2026-09-28. 상태: 순수 처리 코드 구현, 실제 Gmail/AI/DB 연결은 아직 없음.
`REAL_SECRET_GATE=CLOSED`. 이 계약은 기존 금고 암호화/복구와 별도다.

## 지금 동작하는 흐름

```text
합성 Gmail FULL JSON 배열
  → 크기/구조/인코딩 제한 + 본문 정규화
  → 이번 배치의 임시 메일 근거
  + 합성 AI JSON 후보
  → 필드/숫자/날짜/근거 위치 검증
  → pending-review 후보 (저장하거나 확정하지 않음)
```

`normalizeGmailMessagesJson`와 `validateGmailCandidatesJson`는 서버 내부용
순수 함수다. HTTP 요청자가 제출한 근거 배열을 신뢰하는 API가 아니다.
인증/동의/호출량/소유권이 검증된 실제 어댑터를 거쳐 연결해야 한다.
현재 라우트에서는 호출하지 않으며, Gmail/인증 라우트는 계속 503이다.

## 입력과 크기 제한

| 대상 | 현재 상한/규칙 |
|---|---|
| 메일 JSON | 파싱 전 UTF-8 2 MiB, 배열 30개, 중복 메일 ID 거부 |
| MIME | 메일당 128개 파트, payload root부터 깊이 8, 파트당 header 64개 |
| header | 이름/값 각각 2,048 UTF-16 단위; 사용 header 충돌은 거부 |
| 파트 데이터 | encoded 131,072자; 실제 검사하는 plain 파트 decoded 합계 98,304 bytes/메일 |
| 분석에 남기는 내용 | 제목 240자/본문 3,000자, 배치 합계 100,000자 |
| AI JSON | 파싱 전 UTF-8 256 KiB, 후보 100개 |
| 후보 필드 | 이름 160자/단위 40자/근거 인용 500자 |

잘라내기는 제목/본문에만 적용하고 warning을 남긴다. 숫자/날짜/후보를
조용히 잘라내거나 일부만 성공 처리하지 않는다. 하나가 잘못되면 배치를 거부한다.
날짜/인코딩/근거 오류에 입력 원문 대신 고정 오류 코드만 반환한다.

## MIME 지원 범위

- Gmail FULL의 `payload`/`MessagePartBody.data`를 대상으로 한다. RAW 이메일 파서가 아니다.
- outer base64url을 정확히 한 번 디코딩한다. 올바른 padding 포함/생략 모두 허용한다.
- 원본 Content-Transfer-Encoding의 base64/quoted-printable 표기로 두 번 디코딩하지 않는다.
- UTF-8/us-ascii 일반 텍스트만 사용한다. HTML 렌더링, 첨부 다운로드/내용 추출은 하지 않는다.
- multipart/alternative는 한 일반 텍스트 대안만 선택한다. 기타 multipart는 일반 텍스트를 연결한다.
- 첨부로 표시된 하위 트리는 내용 수집에서 제외하지만 구조/크기 한도는 검사한다.
- 본문이 없을 때 Gmail snippet은 부분 근거로 표시한다. snippet이 첨부 내용을 포함하지
  않는다고 보장하지 않으며 개인정보 제거 수단도 아니다.
- RFC 2047 제목은 그대로 둔다. UTF-8 외 charset/모든 실제 메일 형식 지원은 미완료다.
- 문자 수/근거 위치는 UTF-16 기준이고 잘라낼 때 surrogate pair를 나누지 않는다.

Google의 [Message 정의](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)와
[MessagePartBody 정의](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments)를
기준으로 삼았다. 합성 fixture 검증이며 제공자 실메일 호환성 시험이 아니다.

## AI 출력 계약

최상위 필드는 `schema: "keyatlas.gmail-candidates.v1"`와 `discoveries` 두 개뿐이다.
후보 하나에는 아래 필드를 모두 명시해야 하며 알 수 없는 값은 `null`이다.

```json
{
  "evidence_message_index": 0,
  "confidence": "high",
  "benefit_kind": "credit",
  "service_name": {"value": "Synthetic Studio", "part": "subject", "quote": "Synthetic Studio"},
  "benefit_name": null,
  "unit": {"value": "credits", "part": "body", "quote": "grants 100 credits"},
  "granted_amount": {"value": 100, "part": "body", "quote": "grants 100 credits"},
  "remaining_amount": null,
  "trial_days": null,
  "remaining_days": null,
  "expires_at": null,
  "observed_at": null
}
```

각 non-null claim의 인용은 해당 메일의 subject 또는 body에 정확히 한 번 있어야 한다.
결과에는 원문 인용 대신 그 배치 안의 위치를 넣는다. 이것은 **인용이 존재한다는 검증**이지,
AI가 붙인 숫자/이름/날짜가 의미상 맞다는 검증이 아니다. 모든 claim에 `unverified`,
모든 후보에 `pending-review`를 붙이며 `confidence: high`도 자동 승격하지 않는다.

| 구분 | 처리 |
|---|---|
| 지급 100 / 잔량 미기재 | 지급 100 / 잔량 null. 지급량으로 잔량을 채우지 않음 |
| 잔량 0 | 0 그대로 유지. 현재 실조회 잔량으로 주장하지 않음 |
| 메일 internalDate 없음/잘못됨 | receivedAt null. 현재 날짜나 Date header로 조용히 대체하지 않음 |
| 수신일 있음 / 관찰일 미기재 | observedAt null. 수신일과 관찰일을 구분 |
| 날짜만 있는 만료일 | 날짜 그대로. 임의 시간/시간대를 만들지 않음, 만료 확인 필요 |
| 영수증/가입/만료 사건 | 현재 계정 활성/지급/잔량 증거로 자동 취급하지 않음 |
| 여러 메일의 동일 서비스/다른 시점 잔량 | 합산/이름 기반 자동 병합/기존 기록 덮어쓰기 없음 |

후보 index와 evidence index는 **한 배치 안에서만** 유효하다. DB 식별자, 사용자 소유권,
재분석 revision, 영속 중복 방지 또는 익명화 증명이 아니다. 같은 내용을 다시 처리해도
이 함수는 저장 상태를 갖지 않는다. 사용자 확인 기록의 영속화/재시도 처리도 미구현이다.

## 개인정보와 확인 경계

- 모델이 `userId`, 확인 상태, 비밀번호, API 키, 토큰, 복구 코드 필드를 보낼 수 없다.
  알 수 없는 필드는 버리지 않고 배치 자체를 거부한다.
- 그렇더라도 모델이 만든 이름/단위에도 개인정보가 섞일 수 있다. 필드 allowlist나
  본문 미복사는 개인정보 제거/비밀정보 비노출 보장이 아니다. 원문 로그를 만들지 않는다.
- 이름과 단위는 비신뢰 텍스트다. UI는 텍스트로 렌더링하고 HTML·링크·명령으로 실행하지 않는다.
- 메일 원문은 정규화 중 일시적으로 메모리에 존재한다. JavaScript 메모리의 확실한
  zeroization을 보장하지 않는다. 외부 AI 전송·보관은 별도 동의 및 최소화 검토가 필요하다.
- 원본 Gmail ID·전체 제목·본문을 후보 결과에 복사하지 않는다. 분석 시각은 나중에
  서버 시계에서 부여하되 메일 수신/명시 관찰시각과 혼동하지 않는다.

## 다음 구현 순서

1. 인증 principal + 메일 읽기/외부 분석 동의 + 제한량 + 취소를 주입한 합성 orchestration.
2. 사용자가 후보를 검토한 뒤, 같은 사용자의 서비스에만 연결하는 원자적 확인 저장.
3. 재분석 revision/명시 확인/중복 방지/삭제 및 동의 철회 검증.
4. 사용자가 승인한 새 개발 환경에서 실제 OAuth/Gmail/DB 어댑터와 RLS/E2E 검증.

원본 Lovable 프로젝트/repo/DB로 연결하지 않는다. 위의 미완료 단계가 통과하기 전에는
메일 연결 버튼, 실제 분석 호출, 자동 계정 조회 성공 또는 운영 준비 완료를 표시하지 않는다.
