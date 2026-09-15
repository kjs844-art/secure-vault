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
- `/?view=backup`: 합성 암호문 파일 다운로드 준비와 빈 IndexedDB 저장소 전용 복원
- 백업 파일 읽기 전 512 KiB 제한, 기존 Worker 전체 검증 후 원자적 최초 저장, 동일 바이트 재확인

기존 `/` 화면은 메모리 전용입니다. 모든 화면에서 실제 AI 전송은 하지 않습니다.
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
브라우저 내부 저장만으로는 데이터 삭제/자동 공간 회수/기기 분실에 대비할 수 없습니다.
별도 합성 백업 화면에서 내려받은 테스트 파일을 빈 저장소에 복원할 수 있습니다.
공개 테스트 비밀번호이므로 실제 비밀정보 보호용 백업은 아닙니다.
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
npm test -- --maxWorkers=1
npm run build
# 저장소 루트
node scripts/test-wasm.mjs --demo
```

상세 구조·한계·검사 결과: [합성 관계/로컬 저장 작업 기록](../../docs/verification/2026-09-13-synthetic-local-vault.md).

[합성 백업·복원 작업 기록](../../docs/verification/2026-09-14-synthetic-backup-restore.md):
실제 WASM 암호문을 별도 격리 저장소로 왕복하는 테스트를 포함합니다.
`/?view=backup`에서 합성 테스트 확인 → 파일 준비 → 명시적 다운로드를 사용합니다.
복원은 파일 선택 후 별도 버튼으로 시작하며, 기존 금고가 있으면 거부합니다.
파일 확장자/MIME만으로 신뢰하지 않습니다. 다운로드 요청은 디스크 저장 완료의 증거가 아닙니다.

브라우저 저장 제약은 [MDN 저장 용량과 자동 삭제 설명](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria),
저장 완료 판정은 [IndexedDB transaction complete](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event)를 기준으로 합니다.
