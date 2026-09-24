# 로딩·빈 화면·오프라인·오류 상태 UI (협업 작업 29)

콘텐츠 대신 보여 주는 네 가지 상태를 한 컴포넌트(`ViewState`)로 통일합니다.
색·간격은 작업 22의 토큰을, 기본 문구는 작업 23의 카탈로그(`viewState` 절)를 씁니다.

| kind | 쓰는 때 | 스크린리더 역할 |
|---|---|---|
| `loading` | 불러오는 중 | `role="status"` (차분히 알림) |
| `empty` | 보여 줄 항목이 없음 | 없음 (정적 내용) |
| `offline` | 네트워크가 끊김 | `role="status"` |
| `error` | 작업 실패 | `role="alert"` (즉시 알림) |

```tsx
import { getCopy } from "../ui/copy";
import { ViewState, viewStateText } from "../ui/states";

const copy = getCopy("ko");
<ViewState kind="error" {...viewStateText(copy, "error", "SYNC_TIMEOUT")}
  action={<button type="button" onClick={retry}>{copy.common.retry}</button>} />
```

## 지키는 규칙

- **원본 오류 메시지를 화면에 보여 주지 않습니다.** 예외 메시지에는 사용자 데이터가
  섞일 수 있습니다. 대신 짧은 참조 코드(`A-Z a-z 0-9 _ -`, 64자 이하)만 넘기고,
  `viewStateText`가 형식에 맞지 않는 코드는 버립니다.
- 표시 전용입니다. 다시 시도 같은 동작은 호출하는 쪽이 `action`으로 넘깁니다.
- 로딩 표시의 회전 애니메이션은 사용자가 움직임 줄이기를 켜지 않았을 때만 돕니다
  (`prefers-reduced-motion: no-preference`).
- `aria-busy`를 붙이지 않습니다. 알림 영역에 붙이면 로딩 안내가 묻힐 수 있습니다.
- 알림 영역이 화면에 **새로 끼워질 때** 읽어 주는지는 스크린리더마다 다릅니다. 확실한
  알림이 필요하면 항상 떠 있는 알림 영역에 문구를 바꿔 넣는 방식을 함께 쓰세요.
- 기존 화면은 아직 이 컴포넌트를 쓰지 않습니다.
