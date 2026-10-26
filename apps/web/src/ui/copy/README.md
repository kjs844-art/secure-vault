# 한국어·영어 문구 체계 (협업 작업 23)

화면 문구를 한 곳(`copyCatalog.ts`)에서 한국어·영어로 함께 관리합니다.

## 구조

- 한국어(`ko`)가 기준입니다. 영어(`en`)는 같은 모양의 타입을 따르므로 키가 빠지거나
  남으면 **컴파일 오류**가 납니다.
- 비밀번호 종류·환경·상태·권한 라벨은 `domain/vault.ts`의 타입에 묶여 있어, 도메인에
  값이 추가되면 번역이 없다는 오류가 납니다.
- `{count}` 같은 자리표시자는 두 언어가 똑같아야 합니다. `formatCopy`는 값이 빠지거나
  남으면 예외를 던집니다.
- `resolveLocale("en-US")` → `en`. 모르는 언어는 한국어로 돌아갑니다.

```ts
import { formatCopy, getCopy, resolveLocale } from "../ui/copy";

const copy = getCopy(resolveLocale(navigator.language));
formatCopy(copy.connection.targetCount, { count: 3 }); // "연결처 3곳 기록"
```

## 용어 대응표

| 한국어 | English | 뜻 |
|---|---|---|
| 로그인 수단 | Sign-in method | Google·카카오·이메일 등 가입에 쓴 방법 |
| 서비스 계정 | Service account | 특정 서비스 안의 내 계정 |
| 자격 증명 | Credential | 비밀번호·API 키·Secret |
| 연결처 | Connection target | 앱·플러그인·MCP 서버·CLI·CI 등 |
| 연결 기록 있음 | Connection recorded | 사용자가 기록함. **지금 연결돼 있다는 검증이 아님** |
| KeyAtlas 로그인 | KeyAtlas sign-in | 이 앱 자체의 로그인 |
| 외부 서비스 로그인 | External service sign-in | 금고에 기록하는 다른 서비스의 로그인 |

## 쓰면 안 되는 표현

`forbiddenClaims.ts`에 과장·오해 문구를 모았습니다. 예: "모든 가입 서비스를 찾음",
"연결이 살아 있음", "해킹 불가", "unhackable", "production-ready". 카탈로그의 모든
문구는 테스트에서 이 목록으로 검사하며, 다른 화면 문구 검사에도 `findForbiddenClaims`를
쓸 수 있습니다. 부분 문자열 비교이므로 새 금지 표현은 정직한 안내 문장을 막지 않도록
충분히 구체적으로 적습니다.

기존 화면 문구는 아직 이 카탈로그로 옮기지 않았습니다. 이전은 화면 담당자와 조율해 진행합니다.
