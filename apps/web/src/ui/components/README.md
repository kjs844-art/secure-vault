# 공용 표시 컴포넌트 · 디자인 토큰 (협업 작업 22)

`src/ui/tokens/tokens.ts`가 색·간격·모서리·글꼴 값의 단일 기준입니다.
`tokens.css`는 같은 값을 `--ka-*` CSS 변수로 옮긴 파일이며, 두 파일이 어긋나면
`tokens.test.ts`가 실패합니다. 값을 바꿀 때는 `tokens.ts`를 먼저 고친 뒤 CSS를 맞춥니다.

| 컴포넌트 | 역할 |
|---|---|
| `StatusBadge` | 짧은 상태 문구. 의미는 글자로 전달하고 색은 보조 신호로만 씁니다. |
| `SyntheticDataNotice` | "합성 데이터 전용" 경고. 문구는 호출하는 쪽이 넘깁니다. |
| `Surface` | 테두리 있는 패널. `section`/`article`은 제목 id(`labelledBy`)가 있어야 합니다. |
| `KeyValueList` | `dl` 기반 항목·값 목록. 표시용 라벨만 받고 Secret 값은 받지 않습니다. |

## 지키는 규칙

- 표시 전용입니다. 상태, 이벤트 처리, 저장, 네트워크 호출이 없습니다.
- 모든 색은 토큰 변수에서 옵니다. `components.css`에 색 값을 직접 쓰면 테스트가 실패합니다.
- 원격 글꼴·이미지·`@import`를 쓰지 않습니다. 글꼴은 기기에 설치된 것만 씁니다.
- 밝은/어두운 테마 모두 본문과 상태 배지 글자 대비가 WCAG AA(4.5:1) 이상이 되도록 값을 골랐습니다.
  자동 대비 검사는 협업 작업 46에서 다룹니다.
- 기존 `styles.css`와 `local-vault` 화면은 아직 이 컴포넌트를 쓰지 않습니다. 옮기는 작업은
  기능 담당자와 조율한 뒤 별도로 진행합니다.

사용 예:

```tsx
import { StatusBadge, Surface, SyntheticDataNotice } from "../ui/components";

<Surface as="section" labelledBy="items-heading">
  <h2 id="items-heading">합성 금고 항목</h2>
  <SyntheticDataNotice title="합성 데이터 전용">실제 키를 입력하지 마세요.</SyntheticDataNotice>
  <StatusBadge tone="warning">회전 필요</StatusBadge>
</Surface>
```
