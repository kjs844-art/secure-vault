# 2026-09-28 M05A 독립 브라우저 QA: 저장 실패·화면·잠금

## 작업 기준

- 담당 문서: `docs/handoff/mvp-20260927/M05A.md`
- 작업 브랜치: `codex/firstvibe-mvp-05a-browser-qa-20260927`
- 시작 시점 origin tip: `97df4a983accfe1686fee37fbf21958968a8c512` (문서 커밋 이후 코드 기준점은 `34b43e1a5d2f1d81eb2f6456d657fd04ca57332f`)
- 격리 프로필: Playwright chromium headless shell 153.0.8010.12, 임시 user-data-dir, synthetic vault 데이터만 생성
- 대상 URL: `http://127.0.0.1:4173/?view=local-vault` (루프백 `vite preview`, production build)
- `REAL_SECRET_GATE=CLOSED`: 합성 fixture만 사용. 실제 비밀번호/API 키/복구 키/쿠키/개인 금고 백업 없음. 콘솔/HAR/DB 덤프 업로드 없음.

## 빌드·WASM 확인

기존 production build가 없어 문서화된 절차에 따라 생성했다. 운영 체제가 Linux이므로 `scripts/build-wasm.ps1`의 Windows 경로 대신 동등한 단계를 사용했다.

```text
rustup target add wasm32-unknown-unknown
cargo build -p vault-client-wasm --locked --target wasm32-unknown-unknown --features synthetic-demo --release
wasm-bindgen target/wasm32-unknown-unknown/release/vault_client_wasm.wasm --target web --out-dir apps/web/src/generated/vault-wasm-demo --out-name vault_client_wasm --typescript
```

- `wasm-bindgen 0.2.128` 일치 확인 (`wasm-bindgen --version` → `wasm-bindgen 0.2.128`).
- `npm ci --prefix apps/web`: exit 0.
- `npm run typecheck --prefix apps/web`: exit 0.
- `npm test --prefix apps/web`: 49 files, 1487 passed, 0 failed, exit 0.
- `npm run build --prefix apps/web`: exit 0. 산출물 `index-DQ8kyPHW.js`, `syntheticVault.worker-DSt8NJ2n.js`, `vault_client_wasm_bg-DksfBA03.wasm`.
- `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort`: 루프백 프리뷰 기동.

단위 테스트는 가짜(fake) IndexedDB 환경에서 검증된 범위이고, 이번 QA는 실제 Chromium IndexedDB 위에서 앱 전체(React → Worker → WASM → IndexedDB)를 통과하는 브라우저 회귀다. 두 결과는 서로 대체되지 않는다.

## 시나리오와 결과

실제 실행 명령: `node apps/web/tests/mvp-browser/local-vault-qa.mjs` (프리뷰 서버 기동 상태, `QA_BASE_URL` 기본값 사용). 종료 코드 0. 헤니스 소스: `apps/web/tests/mvp-browser/local-vault-qa.mjs`.

각 시나리오는 임시 브라우저 프로필에서 합성 금고를 만들거나 열어서 시작했다. IndexedDB 기록은 페이지에서 `indexedDB.databases()` → `keyatlas-synthetic-vault-v1` → `bundle` 저장소 → `archive` 키를 읽고 바이트 길이와 SHA-256을 계산해 비교했다. 원문 암호문은 출력하지 않았다.

| ID | 시나리오 | 기대 | 실제 | 판정 |
|---|---|---|---|---|
| S1 | 저장 용량 초과(`QuotaExceededError`) 발생 시 기존 데이터 보존 | 기존 `archive` 바이트·해시 불변, 오류 안내 표시, 이후 재열기 가능 | 암호문 3,892 bytes 해시 `8fb852032421…` 유지; UI에 `작업을 확인하지 못했습니다 (quota). …먼저 금고를 다시 열어 확인하세요.` 표시; 재열기 시 동일 해시로 3개 항목 복원 | PASS |
| S2 | 잠금 뒤 화면 제거 | 항목 상세(예시 1/2/3, 발급 계정 등)가 화면에서 사라지고 암호문은 유지 | 잠금 직후 `Example Workshop API Credential` 문자열 미노출; `archive` 해시 불변; 새로고침 후에도 잠김 상태로 시작; 재열기 시 3개 항목 복원 | PASS |
| S3 | 키보드 동작 | Enter로 잠금 가능, 잠금 상태 Tab 순회가 금고 저장 컨트롤에 도달하지 않음 | 포커스된 잠금 버튼에서 Enter → 잠김 전환; 잠김 상태에서 Tab 20회 순회 중 `진행만 암호화 저장`/`저장한 교체 최종 확인`/`선택한 합성 항목 저장`/항목 편집 미노출 | PASS |
| S4 | 모바일 뷰포트 | 360×800에서 좌우 오버플로 없음 | 잠금 해제 상태 scrollWidth/clientWidth = 360/360, 잠금 상태 360/360 | PASS |
| S5 | 업그레이드 실패(버전 불일치) 시 기존 데이터 보존 | 상위 버전 DB를 만나도 삭제·마이그레이션하지 않고 `incompatible` 보고 | DB를 버전 99 + `future-store` 추가 저장소로 조작 뒤 앱 재열기: UI에 `incompatible` 표시; `archive` 해시 불변; DB 버전 99 유지 | PASS |

실패 주입 방식: S1은 페이지 컨텍스트에서 `IDBObjectStore.prototype.put`이 `QuotaExceededError`를 동기적으로 던지도록 패치했다(앱의 단위 테스트 `SyntheticCiphertextStore.test.ts`와 동일한 실패 지점). 저장은 메인 스레드 IndexedDB 트랜잭션에서 발생하며, 워커(`syntheticVault.worker`)는 암호화 연산만 담당한다. S5는 페이지에서 직접 DB를 상위 버전으로 재생성해 앱이 기대하는 버전보다 높은 상태를 만들었다.

S1 검증 중 두 가지 주입 방식을 기각했다. (1) 이미 성공한 `put` 요청에 나중에 error 이벤트를 붙이는 방식은 트랜잭션 커밋을 막지 못해 실제 쓰기가 일어났다. (2) 워커 스크립트에 패치를 주입하는 방식은 저장 경로가 워커가 아니라 메인 스레드임을 확인한 후 무의미함을 확인했다. 최종 방식(동기 throw)만이 실제 쓰기 거부를 재현했다. 기각된 두 실행은 실앱 결함이 아니라 헤니스 오류이며, 판정에 사용하지 않았다.

## 자동화 도구 실패와 앱 실패의 구분

- S1의 quota 실패, S5의 version 실패는 헤니스가 의도적으로 주입한 브라우저 저장 계층 실패다. 앱 코드 실패가 아니다.
- 앱이 이 실패들을 각각 고정 오류 코드(`quota`, `incompatible`)로 보고하고 기존 암호문을 보존했으므로 기대 동작을 충족했다.
- 헤니스 자체의 실패(위 기각 사례)는 별도 단락으로 기록했고 PASS 근거로 사용하지 않았다.

## 미검증 범위 (NOT_RUN / BLOCKED)

- 실제 모바일 하드웨어·터치·생체 인증: NOT_RUN — headless Chromium viewport 에뮬레이션만으로 대체.
- 유예 5분·탭 숨김 자동 잠금: NOT_RUN — 실제 5분 대기와 탭 생명주기는 이번 실행 범위 밖. 기존 #56 브라우저 회귀와 구분된다.
- 다중 writer 충돌·outbox 전체 인증, rollback anchor: NOT_RUN — M05A 범위 외.
- B04 dirty 파일 정리: 수행하지 않음 — 지시에 따라 건드리지 않았다.
- B05 디스크 다운로드/복원: NOT_RUN — M01A 소유이므로 중복 수행하지 않았다.
- 실제 Chrome 전체 프로필, Firefox/Safari, 서버 배포, 실제 Secret: 범위 밖.
- 원격 CI: 실행하지 않았다. 로컬 검증만으로 대체했다.

## 결론

격리 합성 환경에서 저장 실패(quota)·업그레이드 실패(버전 불일치) 시 기존 암호문이 보존되고, 잠금이 화면 내용을 제거하며, 새로고침·키보드·360px 뷰포트 동작이 기대와 일치했다. 문서 업로드, 테스트 통과, PR merge, 실제 배포는 별도 사용자 결정 사항이다.
