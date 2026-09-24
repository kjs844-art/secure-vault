# 저장 전 변경사항 상태 모델 (협업 작업 42)

폼이 "저장하지 않은 변경이 있는지"를 한 곳에서 계산하는 순수 모델입니다.
화면·저장소·네트워크를 모르며, 상태 전이는 모두 새 불변 객체를 돌려줍니다.

```ts
import { beginSave, completeSave, createDirtyForm, editForm, failSave } from "../ui/forms";

let form = createDirtyForm({ label: "예시", connectionIds: [0, 2] });
form = editForm(form, { label: "새 이름" });          // dirty
const { state, ticket } = beginSave(form);            // saving
form = state;
// 저장이 끝나면 ticket.token으로 알려 줍니다.
form = ok ? completeSave(form, ticket.token) : failSave(form, ticket.token);
```

## 규칙

| 상황 | 결과 |
|---|---|
| 값을 바꿨다가 원래대로 되돌림 | 다시 깨끗한 상태 (baseline과 필드별 비교) |
| 저장 중에 또 편집 | 저장이 끝나도 그 편집은 dirty로 남음 |
| 늦게 도착한 이전 저장의 응답 | 무시 (token이 다르면 baseline을 못 바꿈) |
| 저장 실패 | 편집 내용 유지, 다시 저장 가능 |
| 저장 중 되돌리기 | 저장은 계속되고, 끝나면 되돌린 화면이 저장본과 달라 dirty |

- 필드 값은 문자열·숫자·불리언·null과 그 배열만 받습니다. 배열은 순서까지 비교합니다.
  NaN은 NaN과 같고 0과 -0도 같다고 봅니다.
- 없는 필드를 `editForm`으로 추가하면 예외가 납니다.
- 저장은 한 번에 하나만 진행합니다. 저장 버튼은 `canSave`가 false일 때 비활성화하세요.
- `JSON.stringify(state)`는 단계와 바뀐 필드 이름만 씁니다. 필드 값은 로그에 남지 않습니다.
  다만 `state.current`를 직접 출력하면 값이 보이므로 그렇게 하지 마세요.

`bindUnsavedChangesWarning(() => shouldWarnBeforeLeaving(form))`은 탭을 닫거나 새로
고칠 때 브라우저 확인 창을 띄웁니다. 확인 문구는 브라우저가 정합니다. 앱 안에서 다른
화면으로 이동할 때 쓰는 확인 대화상자는 작업 41 범위이며, 문구는 카탈로그 `form` 절에
있습니다. 기존 편집 화면은 아직 이 모델을 쓰지 않습니다.
