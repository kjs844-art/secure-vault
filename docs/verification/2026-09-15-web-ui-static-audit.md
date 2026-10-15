# Web UI 정적 감사 (2026-09-15)

대상은 `apps/web/src/App.tsx`와 `apps/web/src/styles.css`이며, 코드 읽기 기반입니다. 브라우저 직접 조작 결과가 아닙니다.

- 접근성: 시맨틱 `main`/`header`/`section`, 제목 계층, `aria-labelledby`, `aria-label`, 기본 HTML button을 확인했습니다.
- 빈 상태: 고정 합성 레코드만 반환하므로 빈 목록 메시지는 **미검증**입니다.
- 로딩/오류: 동기 `useMemo` 렌더링이며 별도 loading/error 경계는 **미검증**입니다.
- 반응형: 폭 계산과 `max-width: 600px` 규칙은 확인했지만, 360px의 실제 줄바꿈·가로 스크롤·포커스는 **미검증**입니다.
- 안전 경계: 실제 Secret 입력 없이 합성 메타데이터 미리보기만 사용하도록 안내합니다.

실제 alpha 전에는 빈 목록·지연·repository 오류 fixture와 360px 브라우저 캡처가 필요합니다.
