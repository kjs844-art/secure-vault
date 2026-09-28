# 메일 후보의 사용자 확인·삭제 제어

2026-09-28. `src/server/review/`는 provider 독립 서버 내부 코드다.
실제 인증/DB/공개 라우트/화면에는 연결하지 않았다. 현재 구현된 어댑터는 테스트의
메모리 모델뿐이다. 사용자 요청에 따라 DB·도메인·배포 실설정은 보류 중이다.
새 DB 파일, 클라우드 계정 또는 migration을 만들거나 실행하지 않았다.

## 전체 흐름

```text
서버의 검증된 메일 분석 후보
  → makeCandidateContent: bounded 값/출처/검토 이유만 투영
  → 향후 소유권 검증된 후보 저장 어댑터 (현재 미연결)
  → preview: 후보·서비스의 소유권/revision 확인 + 사용자가 편집한 값 고정
  → 화면에 그 값 그대로 표시 (현재 미구현)
  → confirm: preview ID와 일회 operation으로 정확한 snapshot 확인
  → 후보 소비 + 혜택 생성 + operation 기록을 하나의 transaction으로 요청
  → 결과 반환 직전에도 권한 재확인
```

미리보기 생성과 저장 확인은 별도 동작이다. preview를 만들었다고 혜택이 저장되지는 않는다.
코드에는 auth/DB 어댑터를 신뢰 경계로 두되, 실제 구현이 완료됐다고 가정하는 fallback이 없다.
후보/서비스 생성, 로그인, 실제 사용자 확인 화면과 공개 API wiring은 후속 작업이다.

## 명령과 상태

| 명령 | 허용 입력 | 결과 |
|---|---|---|
| `preview` | candidate ID/revision, service ID/revision, 정확한 9개 values | 5분 또는 세션 만료 중 이른 시각까지 유효한 고정 snapshot |
| `confirm` | preview ID, operation ID, `decision: confirm` | 저장된 preview 그대로 확인; 새 values/owner/proof 필드 거부 |
| `reject` | preview ID/revision, `decision: reject` | 미소비 preview만 폐기. 후보와 기존 혜택은 삭제하지 않음 |
| `remove` | benefit ID/revision, operation ID, `decision: delete` | 앱 기록과 해당 후보/preview 내용 제거, 최소 삭제 표식 유지 |

- values: name, kind, unit, grantedAmount, remainingAmount, trialDaysStated,
  remainingDaysStated, expiresAt, observedAt. 모르는 값은 명시적인 null이며 0과 다르다.
- 표시 이름의 markup도 검증된 HTML이 아니다. 향후 UI는 text로 출력하고 innerHTML로 실행하지 않는다.
- 사용자·세션·generation·확인 시각·출처·proof는 서버에서만 정한다.
- 검증된 server principal을 반환해야 한다. 요청 body의 userId/role을 auth 어댑터에 넘기면 안 된다.
- preview는 해당 사용자/세션 revision/data generation에 결합된다. pending 내용은 revision 1에서
  불변이다. 편집하려면 새 preview ID를 발급하고 다시 보여준다.
- 같은 이름의 서비스를 자동 병합하거나 다른 소유자의 서비스로 연결하지 않는다.
- 후보가 pending이고, 후보/서비스 revision과 내용이 미리 본 snapshot과 같아야 한다.
  다른 후보/서비스로 바뀌면 새 preview가 필요하다.
- 받아들인 후보 ID는 재사용하거나 pending으로 되돌리지 않는다. 재분석은 별도 후보를 제안한다.
  이 코드가 실제 재분석·영구 source 중복 제거까지 구현한 것은 아니다.

## 검토와 사실 증명은 다르다

저장 결과는 `accepted-by-user`이지만 `accountProof`와 `currentBalanceProof`는 계속
`not-established`다. 사용자의 확인을 실제 가입 여부·현재 구독 상태·현재 잔액 인증으로 바꾸지 않는다.
AI의 high confidence도 이 상태를 바꾸지 않는다.

`valueOrigins`는 원래 추출값과 같은지(`email-extracted`), 사용자가 바꿨는지
(`user-corrected`)를 기록할 뿐, 수정한 값의 사실성을 인증하지 않는다.
메일 수신일·내용의 관찰일·분석 시각·사용자 검토 시각은 구분하며 null/date-only/offset을 보존한다.
관찰일이 없다고 검토 시각을 채워 넣지 않는다.

기존 UI `BenefitRecord`는 관찰일 등 필수 필드가 달라 직접 캐스팅하지 않는다.
기존 `sumByUnit`/`remainingRatio`도 provenance를 검증하지 않으므로 이 결과를 그대로
현재 잔액 합계나 현재 이용 중 표시로 투영하면 안 된다. 별도 화면 정책/변환 검증이 필요하다.

## 출처와 개인정보

- source에는 불투명한 분석 operation/메일 연결 참조, batch-local candidate index,
  schema/policy, 수신/분석 시각, 서비스명, 원래 추출값/confidence/reviewReasons만 둔다.
- 원문 본문·제목 전체·Gmail 원본 ID·quote/span은 이 저장 envelope에 없다.
  `evidenceAvailability: not-retained`이며 이후 원문 인용 재검증이 가능하다고 표시하지 않는다.
- `PARTIAL_MAIL_TEXT` 등 원래 검토 이유를 유지한다. 내용이 잘렸다는 경고를 저장 확인으로 지우지 않는다.
- 값/이름/불투명 참조도 개인정보일 수 있다. PII 자동 제거·암호화 금고·운영자 열람 불가를 보장하지 않는다.
- batch index는 영속 source identity가 아니다. 삭제한 메일이 미래 분석에서 다시 제안되는 것을
  영구 차단하려면 별도 stable source binding/사용자 정책이 필요하다.

## 실제 어댑터의 필수 의무

1. transaction 진입과 commit 때 실제 세션·owner·session revision·data generation·만료를 검증한다.
2. 모든 조회/쓰기는 owner 범위로 제한한다. 반환 ID도 요청한 ID와 일치해야 한다.
3. ID/owner/generation을 변경하지 않고 unique 제약과 CAS를 원자적으로 강제한다.
   `(ownerId, operationId)`와 candidate의 일회 소비는 병렬 요청에서도 중복되지 않아야 한다.
4. callback 실패/false CAS 뒤에는 모든 쓰기를 rollback한다. 순차 update만 했다고 원자성이 생기지 않는다.
5. `limitCommitTime`으로 등록된 세션/preview의 가장 빠른 deadline 이후에는 commit하지 않는다.
   callback 검사 뒤 commit이 지연될 수 있으므로 어댑터도 commit 조건을 강제해야 한다.
6. pending preview 내용을 변경하지 않는다. 종료 상태/삭제 표식을 다시 pending/live로 돌리지 않는다.
7. 삭제 때 관련 preview 내용을 빠짐없이 제거한다. 동시 preview 생성과의 phantom/격리 문제도 막는다.
8. commit이 완료된 뒤에만 callback 결과를 반환한다. 실제 DB 격리/RLS/내구성/프로세스 실패 검증은 별도다.

이 의무를 메모리 모델로 시험한 결과는 실제 DB transaction/동시성/RLS/영속 삭제의 증거가 아니다.
어댑터 자체 timeout, 장애 대조, 인증/CSRF/rate limit, JSON 역직렬화 전 HTTP body 크기 제한,
사용자의 소유권 API 검증은 연결 전에 필요하다.

## 중복·불확실한 결과·삭제

operation은 owner 범위에서 명령 종류와 정규화된 ID-only 요청에 결합된다.
같은 operation의 다른 요청은 충돌이며, 같은 요청의 반복은 새 레코드를 만들지 않고 현재 결과를 조회한다.
이미 삭제된 결과는 `deleted`, `content: null`이다. 삭제 전 성공 payload를 replay하지 않는다.

저장 후 응답을 잃거나 commit acknowledgement가 지연되면 실패 응답이어도 이미 저장됐을 수 있다.
service는 고정 오류만 반환하며 내부 오류 원문을 노출하지 않는다. **실패 = rollback 완료가 아니다.**
같은 operation으로 재조회해야 하며 새로운 operation으로 무조건 재시도하지 않는다.
commit 후 결과를 기다리는 동안 세션이 바뀌어도 최종 guard가 payload 반환을 차단한다.

삭제는 앱의 혜택/후보/preview 내용에 대한 것이다. Gmail 원본 메일을 삭제하지 않는다.
삭제 ID/owner/generation/revision과 consumed operation은 재생 방지를 위해 남는다.
그 표식도 개인정보이며 보관 기간, 전체 계정 삭제/최소 보존 정책은 별도 확정해야 한다.
표식을 지우면 과거 요청의 재생 방지 성질이 바뀌므로 무조건 purge했다고 하지 않는다.

이전에 반환한 응답·브라우저 메모리·캐시·로그·백업까지 회수/소거한 것은 아니다.
향후 UI는 receipt의 `dataGeneration + benefitRevision`으로 이미 본 삭제보다 오래된 saved 응답을
무시해야 한다. 이를 연결하지 않고 “늦은 응답에도 절대 재등장하지 않는다”고 주장하지 않는다.

## 현재 상태

agent-consent-patterns의 action preview, 명시적 결정, 좁은 소유권, 정직한 처리 기록 원칙을 적용했다.
최종 디자인이나 UI 라이브러리를 추가하지 않았다. `REAL_SECRET_GATE=CLOSED`.
DB·도메인·배포 작업은 사용자가 재개할 때까지 계속 보류한다.
