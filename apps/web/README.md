# KeyAtlas Web — 합성 데이터 전용

React + TypeScript + Vite 기능 골격과 Rust/WASM 합성 로컬 금고입니다.
디자인 확정본이나 실제 비밀정보용 제품이 아닙니다.

## 현재 범위

- React + TypeScript + Vite 실행 기반
- 비밀번호, API 키, MCP 자격 증명, 복구 코드 메타데이터 모델
- `DEMO_VALUE_ONLY_` 표시가 붙은 합성 Secret 전용 fixture
- Secret을 반환할 수 없는 읽기 전용 catalog repository 경계
- AI 제공자에게 전달 가능한 필드만 복사하는 명시적 허용목록 변환기
- Secret, 계정 힌트, 메모, URL, 연결 이름이 AI payload에 포함되지 않는 테스트
- `/?view=local-vault`: Rust가 만든 합성 암호문 묶음을 IndexedDB에 저장하고 다시 열기
- 인증된 합성 메타데이터의 서비스 → API 자격 증명 → MCP/CLI/CI 관계 표시
- 잠금·새로고침·탭 숨김 시 표시 내용 초기화와 이전 비동기 결과 재표시 차단
- 기존 데이터 덮어쓰기, 오류 시 자동 삭제, 자동 마이그레이션, 임시 저장 대체 없음
- `/?view=synthetic-backup`: 합성 암호문 파일 준비, 명시적 확인 후 크기 제한 검증, 빈 저장소에만 복원
- 백업 화면에도 5분/탭 숨김/페이지 이탈 자동 잠금 적용: 확인란·File 참조·다운로드 URL 및 늦은 결과 해제

기존 `/` 화면은 메모리 전용입니다. 세 화면 모두 실제 AI 전송은 하지 않습니다.
새로운 관계 목록은 기존 AI payload 변환기에 연결하지 않았습니다. 연결 이름과
서비스명도 사적인 정보이므로 로컬 표시 전용이며 로그·분석으로 보내지 않습니다.

## 절대 금지

이 웹앱은 아직 실제 비밀번호, API 키, Secret, 복구 코드 또는 개인정보를
입력하거나 저장하도록 승인되지 않았습니다. 실제 Secret gate는 닫혀 있습니다.

**데모 비밀번호는 Rust 코드에 공개된 고정 테스트 값입니다.** 실제 암호화·인증 코드를
실행하지만 앱을 가진 사람에게 기밀성을 제공하지 않습니다. 현재 열기 버튼은 사용자
인증이 아니라 공개 테스트 비밀번호로 합성 금고를 여는 동작입니다.

인증 성공이 합성 출처를 증명하지는 않습니다. 프레임 전체의 서명/완전성 manifest,
최신성, rollback 방지도 구현하지 않았습니다. Worker는 성능·수명 관리 경계이지 악성
같은-origin JavaScript 격리 장치가 아닙니다. JS 문자열·외부 복사본·캡처까지 확실히
지우는 기능은 아닙니다. 금고 origin에 광고, 분석, 임의 제3자 JS를 추가하지 않습니다.

## 로컬 저장의 의미

이 기기의 같은 브라우저 프로필, 같은 origin(프로토콜·호스트·포트)에 저장합니다.
`localhost`와 `127.0.0.1`, 다른 포트, 다른 브라우저는 저장 영역이 다릅니다.
브라우저 데이터 삭제/자동 공간 회수/기기 분실에 대비한 백업이 아닙니다.
서버·클라우드 동기화가 없고, 기존 네이티브 SQLite 저장소와도 아직 연결하지 않았습니다.

IndexedDB에는 목록이나 키 대신 암호문 `Uint8Array`만 저장합니다.
DB: `keyatlas-synthetic-vault-v1`, store: `bundle`, key: `archive`.
입력은 1–524288바이트로 제한합니다.

## 로컬 실행

```powershell
# 저장소 루트, Rust WASM target 및 프로젝트 버전의 wasm-bindgen CLI 필요
.\scripts\build-wasm.ps1 -SyntheticDemo
cd apps/web
npm ci --ignore-scripts
npm run dev -- --port 4178 --strictPort
```

`http://127.0.0.1:4178/?view=local-vault`에서 **합성 금고 만들기**를 누릅니다.
새로고침 후 **저장된 합성 금고 열기**로 다시 확인합니다. 연산 중 잠금으로 취소할 수
있지만 이미 시작된 암호문 DB 저장은 완료될 수 있습니다. 오래된 결과는 재표시하지 않습니다.

생성된 WASM·node_modules·dist는 Git 제외 대상으로 fresh checkout에서 다시 빌드합니다.
기본 WASM 빌드(`-SyntheticDemo` 제외)는 합성 생성/복원 exports를 제외합니다.
웹 기능 화면은 합성 빌드를 사용하므로 웹 build 성공은 실제 Secret용 release 승인이 아닙니다.

## 검증

```powershell
npm run typecheck
npm test
npm run build
# 저장소 루트
node scripts/test-wasm.mjs --demo
```

상세 구조·한계·검사 결과: [합성 관계/로컬 저장 작업 기록](../../docs/verification/2026-09-13-synthetic-local-vault.md).

브라우저 저장 제약은 [MDN 저장 용량과 자동 삭제 설명](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria),
저장 완료 판정은 [IndexedDB transaction complete](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event)를 기준으로 합니다.

## 로컬 검색과 자동 잠금

열린 합성 금고의 서비스·항목·연결처·표시 유형/상태를 검색할 수 있습니다.
단어를 여러 개 입력하면 모두 일치하는 항목을 표시하며 연결 있음/없음/MCP로 좁힐 수 있습니다.
검색어는 최대 256 UTF-16 코드 단위이며 앱 저장소, URL, 서버 또는 AI에 전송하지 않습니다.
잠금·재열기 시 검색어와 분류가 초기화됩니다. 시계/수명 주기 자동 잠금은
[자동 잠금 기록](../../docs/verification/2026-09-15-local-session-hardening.md),
검색 동작과 검증 경계는 [로컬 검색 기록](../../docs/verification/2026-09-15-local-catalog-search.md)을 참고하세요.

## 합성 백업·복원 연습

금고 화면 하단의 **합성 금고 백업 · 복원 연습**을 엽니다. 합성 테스트 사용 확인 후
현재 암호문을 인증해 `.katldemo` 다운로드 링크를 준비합니다. UI의 “다운로드 요청”은
파일 저장 성공이 아닙니다. 다운로드 목록에서 실제 저장 여부를 확인해야 합니다.

복원은 별도 브라우저 프로필 등 **기존 금고가 없는 저장소**에만 허용합니다.
파일을 선택할 때 크기만 확인하며 복원 버튼을 눌러야 읽습니다. 최대 512 KiB,
지원 버전/형식 확인, 기존 Worker/WASM 인증, 원자적 빈 저장소 생성, 동일 바이트
readback 순서입니다. 기존·손상된 금고의 자동 삭제/덮어쓰기는 제공하지 않습니다.
복원 후에도 금고 목록은 잠겨 있으며 금고 화면에서 직접 다시 열어야 합니다.

취소/잠금은 이미 시작된 DB 커밋이나 브라우저 다운로드를 되돌리지 않습니다.
Worker의 표시 메타데이터 응답은 메인 스레드로 전달된 뒤 백업 코드에서 폐기되며,
이 화면은 목록/키 원문/파일명을 상태로 보관하거나 표시하지 않습니다.

통합 검사: 349 tests와 타입 검사·빌드 통과. 실제 브라우저의 File/DataTransfer를 통한
별도 저장소 복원·재열기·기존 값 보존은 확인했습니다. 그러나 테스트 Chrome의
디스크 다운로드가 `Download error`로 실패했으므로 **네이티브 파일 선택과 실제
디스크 백업 왕복은 미검증**입니다. [검증 기록](../../docs/verification/2026-09-15-backup-session-integration.md)을 참고하세요.
