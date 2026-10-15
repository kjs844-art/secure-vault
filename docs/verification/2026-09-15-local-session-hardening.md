# 2026-09-15 로컬 웹 세션 자동 잠금

## 기준과 통합 범위

작업 브랜치: `codex/firstvibe-local-session-hardening`.
작업 폴더: `C:\Users\USER\Documents\ChatGPT\KeyAtlas\secure-vault-session-hardening`.

기반 `abae281`은 웹/IndexedDB/Worker/WASM 관계 목록 구현이다. 기존 데이터 보존 검사 커밋 `79d9ac8`, 기록 `78c9f4c`를 이 별도 브랜치에 cherry-pick했다 (`fe98ce5`, `246ed33`). main 또는 기존 PR #2는 변경하지 않는다.

다른 작업 폴더의 미커밋 백업/복원 및 AI 도구 변경은 읽기 전용 상태 확인만 했다. 자동 잠금 연결 시 `LocalVaultPanel.tsx`가 겹칠 수 있으므로 나중에 해당 담당 작업과 통합할 때 effect와 import를 함께 검토해야 한다.

## 구현

- `bindVaultAutoLock.ts`: session의 busy/open 상태에만 5분 무입력 제한 적용.
- 키보드/포인터의 trusted 이벤트만 만료 전 기한을 갱신한다. 입력 내용은 기록하지 않는다.
- `Date.now()`와 `performance.now()`의 경과 시간 중 하나라도 만료되면 잠금. 시계 역행/비정상 값은 잠금으로 처리한다.
- 1초 주기, focus/pageshow, 세션 상태 알림에서 기한 확인. 브라우저가 콜백을 지연한 경우 정확히 5분 시점 실행을 보장하지 않지만, 다음 확인 시 만료된 세션을 연장하지 않는다.
- 탭 숨김/pagehide 및 React effect 해제 시 잠금. 탭 복귀 자체로 자동 잠금 해제하지 않는다.
- session의 기존 generation 취소 기능을 사용하여 늦은 결과가 다시 표시되지 않게 한다.
- 이벤트 등록·구독·타이머를 정리하는 멱등 cleanup 제공.
- `LocalVaultPanel.tsx`의 기존 visibility effect를 공통 정책으로 연결하고 안내 문구만 보강했다. 디자인 재설계 없음.

```text
상태: busy/open ── 입력/시계/브라우저 수명 이벤트 ──> 만료·숨김 확인
                                                        │
                                                        ▼
                           session.lock → generation 무효화 → Worker 취소
                                      └→ 목록 제거 → locked 유지
```

## RED 중심 검토

| 실패 조건 | 방어/검사 |
|---|---|
| 타이머가 절전 중 지연돼 돌아온 입력으로 기한 연장 | 입력 갱신 전에 만료 확인, 벽시계와 단조시계 동시 사용 |
| JS dispatchEvent가 무한히 세션 연장 | isTrusted 검사. same-origin 악성 JS에 대한 보안 장벽은 아님 |
| 시계가 뒤로 가서 열림 상태가 장기 지속 | 마지막 관측보다 역행하면 잠금 |
| 숨긴 탭에서 pending 복원 완료 후 목록 재등장 | busy 상태도 정책 적용, 기존 generation 취소 재사용 |
| 화면 제거 후 중복 listener/timer 유지 | cleanup과 재호출 무효화 테스트 |
| 잠금과 동시에 기존 암호문 삭제 | 저장소 삭제/변경 API를 이 정책에서 호출하지 않음 |

## 실행 결과

| 명령 | 결과 |
|---|---|
| `npm run typecheck` | 종료 코드 0 |
| `npm test -- --maxWorkers=1 src/features/local-vault/bindVaultAutoLock.test.ts` | 신규 18개 통과, 종료 코드 0 |
| `npm test -- --maxWorkers=1` | 6개 파일, 총 183개 통과, 종료 코드 0 |
| `scripts/build-wasm.ps1 -SyntheticDemo -Release` | 실제 WASM 생성, 종료 코드 0 |
| `npm run build` | TypeScript/Vite, Worker/WASM 포함, 종료 코드 0 |
| `node scripts/test-wasm.mjs --demo` | 실제 WASM 347 checks, 2 catalogs, 23 archive rejections, 종료 코드 0 |

오프라인 `npm ci --ignore-scripts`는 vitest 캐시 없음으로 실패했다. 기존 웹 작업 폴더와 package-lock이 줄바꿈을 제외하고 완전히 같은지 확인한 후 node_modules만 새 작업 폴더로 복사했다. `npm ls --depth=0`은 잠금 버전과 일치하며 종료 코드 0. 소스·개인 금고·환경변수·DB는 복사하지 않았다. 외부 다운로드 없음.

## BLUE 요약 / 증거 경계

실제 사용자 인증을 추가하지 않고 합성 데모의 로컬 화면 수명 관리를 강화했다. 공개 데모 비밀번호가 그대로이며 기밀성이 있는 서비스가 아니다. JS 문자열/스크린샷/기존 참조의 메모리 삭제, 악성 same-origin 스크립트, 다른 탭 동시 잠금은 보장하지 않는다.

18개 신규 검사는 실제 SyntheticVaultSession과 제어 가능한 이벤트/시계 port를 사용한 자동 테스트다. 실제 브라우저에서 5분 대기·OS 절전·모바일 수명 주기·접근성 보조 입력을 재현한 실기기 검사는 아직 하지 않았다. 빌드만으로 그 동작까지 검증했다고 주장하지 않는다.

2026-09-14의 네이티브 테스트 차단은 CodeIntegrity/Operational 이벤트 3077 두 건에서 해당 bounds/VFS 바이너리의 코드 무결성/서명 정책 거부로 확인했다. 정책을 변경하거나 우회하지 않았다. 이번 WASM 실행 검사는 별도 웹 플랫폼 검증이며 네이티브 전체 회귀 통과를 대신하지 않는다.

`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`. 도메인·배포·결제·계정 생성·main 병합 없음.
