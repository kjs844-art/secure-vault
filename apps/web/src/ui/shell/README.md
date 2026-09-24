# 반응형 앱 셸 골격 (협업 작업 36)

모든 화면이 들어갈 틀(`AppShell`)입니다. 레이아웃만 담당하고 상태·라우팅·효과는 없습니다.

```
좁은 화면 (< 960px)          넓은 화면 (≥ 960px)
┌──────────────┐           ┌──────────────────────────┐
│ header       │           │ header                   │
├──────────────┤           ├──────────────────────────┤
│ notice       │           │ notice                   │
│ nav          │           │ nav    │ main            │
│ main         │           │ (240px)│                 │
├──────────────┤           ├──────────────────────────┤
│ footer       │           │ footer                   │
└──────────────┘           └──────────────────────────┘
```

```tsx
import { getCopy } from "../ui/copy";
import { AppShell } from "../ui/shell";

<AppShell brand="KeyAtlas" navLabel={getCopy("ko").shell.primaryNavigation}
  nav={<ul>…</ul>} notice={<SyntheticDataNotice … />} footer="…">
  {page}
</AppShell>
```

## 지키는 규칙

- 랜드마크는 `header`·`nav`·`main`·`footer` 하나씩입니다. `nav`를 넣으면 `navLabel`이
  반드시 있어야 합니다(스크린리더가 메뉴 이름을 읽음).
- `main`은 `id="main-content"`(바꿀 수 있음)와 `tabindex="-1"`을 가집니다. 건너뛰기
  링크가 이곳으로 포커스를 옮길 수 있게 하려는 것이며, 링크 자체는 작업 44 범위입니다.
- 긴 단어나 URL이 있어도 가로 스크롤이 생기지 않게 grid 열을 `minmax(0, 1fr)`로 둡니다.
- 헤더·안내문·본문·푸터의 왼쪽 선이 최대 1200px 폭 안에서 맞춰집니다.
- 모든 색은 토큰 변수에서 옵니다. 브레이크포인트 960px은 `appShellWideMinWidthPx`와
  같아야 하며 테스트로 확인합니다.
- 좁은 화면에서는 메뉴가 본문 위에 쌓입니다. 접는 메뉴는 상태가 필요해 이 골격에 넣지 않았습니다.
- 기존 `App.tsx`와 금고 화면은 아직 이 셸을 쓰지 않습니다.

## 확인한 것

Chromium(Playwright)으로 390px·1280px·1920px, 밝은/어두운 테마를 렌더링해 가로 넘침이
없는지, 메뉴가 좁은 화면에서는 위, 넓은 화면에서는 옆에 오는지, 왼쪽 선이 맞는지를 쟀습니다.
