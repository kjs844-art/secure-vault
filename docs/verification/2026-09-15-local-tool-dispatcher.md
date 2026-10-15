# 2026-09-15 합성 로컬 도구 dispatcher

기준: `codex/firstvibe-local-session-hardening`, GitHub 백업 HEAD `bc860a2` 이후의 로컬 변경.
다른 작업 브랜치 `5f5d12c`의 원본을 수정하지 않고 현재 검색 로직으로 재구성했다.
전체 자율 구현 목표와 실제 제품 출시를 완료했다는 기록이 아니다.

## 흐름과 파일

```text
열린 합성 금고 → 로컬 도구 패널 → 닫힌 입력 계약 → 세션에 묶인 dispatcher
                                                 ├─ 사용자 화면: private 결과 목록
                                                 └─ 호출 응답: 고정 성공/오류 receipt

잠금 / 재열기 / 화면 이탈 / 새 요청 → 이전 결과와 대기 작업 무효화
```

| 파일 | 책임 |
|---|---|
| `apps/web/src/bridge/syntheticToolProtocol.ts` | 입력 객체 검증·복사, 3개 op 허용목록, 128 UTF-8 bytes, 0–500 결과 한도 |
| `apps/web/src/features/local-vault/SyntheticVaultTools.ts` | effect 기반 구독, 세션 세대 확인, latest-wins, 즉시 잠금, private UI state와 receipt 분리 |
| `SyntheticToolPanel.tsx` (동일 폴더) | 접힌 기능 확인 패널, 로컬 입력, 고정 응답과 사용자 결과 분리 표시 |
| `LocalVaultPanel.tsx` (동일 폴더) | 열린 세대에서만 패널 마운트; 기존 검색과 백업 링크 유지 |
| 프로토콜/컨트롤러와 같은 폴더의 `.test.ts` | 각각 64개와 62개 회귀 사례 |

검색과 분류는 각각 결과를 교체하는 별도 동작이다. 정규화·AND 검색·연결처 및
종류/상태 검색은 기존 `searchLocalCatalog`를 재사용한다. 검색어를 저장하거나
로그로 내보내지 않고, 결과 수 제한은 검색과 분류 모두에 적용한다.

## RED 중심 검토와 대응

| 위험 | 구현/검사 | 경계 |
|---|---|---|
| 임의 명령이나 추가 필드를 허용 | search_catalog/filter_catalog/lock_vault만 허용, 정확한 own data fields 검사 | 이미 디코딩된 JS 객체 계약이며 HTTP/JSON parser 아님 |
| 질의 길이 단위 혼동·불필요한 처리 | 싼 UTF-16 길이 제한 먼저, 그 뒤 잘못된 surrogate와 실제 UTF-8 byte 검사 | 입력 전체 메모리 할당 전 보호를 제공하는 transport는 아직 없음 |
| 결과 목록/질의가 AI 응답으로 나감 | `state.entries`만 local UI에 노출, 메서드 반환은 ok/action 또는 error/code | 같은 JS 영역이 손상되면 방어 경계가 될 수 없음 |
| 결과 개수로 항목 존재를 알려 줌 | match/no-match/개수/참조/이름을 receipt에 넣지 않음 | 외부 AI 전송 기능을 승인하거나 구현한 것은 아님 |
| 검색 대기 중 잠금 이후 결과 부활 | parsing 및 await, publish 전후 세대·request 재확인 | 이미 호출자가 보관한 JS 문자열은 지울 수 없음 |
| Proxy·구독자·cleanup 재진입 | 현재 binding과 최신 invocation 확인, 이전 cleanup은 새 binding 유지 | 같은 origin의 실행 코드를 격리하는 sandbox는 아님 |
| lock이 검색 뒤로 밀림 | lock은 첫 await 이전 실행, busy/locked 상태에서도 적용 | unlock/create/reveal/copy/export/외부 실행은 제공하지 않음 |
| 알 수 없는 오류 값 유출 | thrown code/message/cause를 읽지 않는 고정 fallback | 오류 로그 수집/분석 SDK를 추가하지 않음 |

독립 에이전트가 현재 parser/controller/UI/테스트/설명을 읽기 전용으로 검토했고
구체적인 차단 결함을 추가로 발견하지 않았다. 독립 런타임 재실행이나 전체 보안 감사는 아니다.

## 검증 증거

작업 디렉터리: `apps/web`.

| 검사 | 결과 |
|---|---|
| 최초 프로토콜 회귀 | 63 PASS / 1 FAIL, 긴 질의의 검사 순서 확인 (exit 1) |
| `npm.cmd test -- src/bridge/syntheticToolProtocol.test.ts --maxWorkers=1` | 순서 수정 후 64/64, exit 0 |
| 컨트롤러 최초 실행 | 구현 모듈 없음으로 실패, 이후 구현 |
| `npm test -- src/features/local-vault/SyntheticVaultTools.test.ts --maxWorkers=1` | 62/62, exit 0 |
| `npm.cmd run typecheck` | exit 0 |
| `npm.cmd test -- --maxWorkers=1` | 13개 파일, 475/475, 실패 0, exit 0 |
| `npm.cmd run build` | TypeScript + Vite + Worker/WASM asset, exit 0 |

현재 코어/백업 회귀를 포함하지만 Node의 저장소 검사는 fake-indexeddb 대역이며,
이 실행으로 실제 모바일·운영 인증·네이티브 Rust 전체 QA를 검증한 것은 아니다.

## 실제 화면 검증 상태

agent-browser 스킬의 core 지침에 따라 별도 세션
`keyatlas-tools-20260915-7e28e6b164fe`와 loopback preview `127.0.0.1:4187`을 준비했다.
브라우저 자동 시작에서 `CDP response channel closed`가 발생했고 이번 새 도구 패널의
snapshot/클릭 증거는 얻지 못했다. `doctor --offline --quick`은 5 PASS/1 WARN/0 FAIL,
활성 daemon 없음으로 나왔지만 실제 화면 검증 성공은 아니다.
해당 세션의 close 명령은 `Browser closed`를 반환했다. 기존 사용자 프로필에는 연결하지 않았다.

이 오류를 앱 결함이나 Chrome/OS의 확정 원인으로 단정하지 않는다. 신규 패널의 실제
검색·분류·잠금·재열기와 StrictMode 마운트 흐름은 후속 브라우저 검증이 필요하다.
이전 합성 백업 화면에서 확보한 브라우저 결과는 이번 패널의 증거로 대체하지 않는다.

### 후속 Comet 검증과 React key 수정

같은 날 일반 권한의 격리 Comet 세션에서 localhost 탭을 직접 선택하여 검증했다.
브라우저 실행 옵션을 명령마다 동일하게 유지했다. 자동으로 열린 Perplexity 시작 탭은
로그인/조작하지 않고 닫았으며, 이를 앱의 네트워크 호출이나 기능 검증으로 취급하지 않았다.
Vite 개발 서버의 StrictMode 설정에서 다음 실제 DOM/조작 결과를 얻었다.

- 합성 금고 3개 생성 → `Example CLI` 검색 → 예시 3만 표시, 고정 search receipt 확인.
- 전체/연결 있음/연결 없음/MCP 분류 결과 각각 3/2/1/2개, 응답은 모두 고정 filter receipt.
- 일치 없음은 0개를 화면에만 표시하고, search receipt는 일치하는 경우와 동일.
- 129 UTF-8 bytes 질의는 `LIMIT_EXCEEDED`; 이전 결과 영역 제거.
- 잠금 후 패널 DOM 제거; 재열기 후 빈 질의/미실행 상태; 새로고침도 잠김.
- 결과가 있는 탭을 숨겼다가 돌아오면 자동 잠금과 패널 제거.

초기 클릭 검사는 통과했지만 Vite 콘솔에서 형제 패널의 중복 React key 경고가 발견됐다.
검색과 도구 패널에 `catalog-세대` / `tools-세대`로 고유한 key를 주도록 수정했다.
수정 후 새 브라우저에서 검색→잠금→재열기를 두 번 반복해 모두 통과했고, 새 콘솔의
warning/error와 page error는 0건이었다. 자동 단위 테스트만으로 발견한 문제는 아니다.

마지막 키 수정과 저장소 후속 변경을 포함한 타입 검사·웹 전체 523/523 테스트·빌드는 exit 0.
격리 Comet close 성공, 직접 시작한 Vite만 Ctrl+C로 종료했다. 사용자 프로필·IDE는 닫지 않았다.
모바일 실기기, 모든 브라우저, 5분 실제 대기, 운영 인증/배포 검증을 완료한 것은 아니다.

## BLUE와 다음 단계

- 개인 금고 projection과 공개 보안 가이드 플러그인을 분리하는 기존 명세를 유지한다.
- 위 Comet 조작/DOM 정리 증거를 유지하며 모바일 및 제품 출시 게이트를 별도로 검증한다.
- 이후 합성 수동 등록·연결 관리·회전 흐름, 동기화 계약과 복구/기기 수명 주기를 계속 구현한다.
- 도메인·배포·디자인·운영 계정/결제와 실제 Secret 개방은 사용자 결정/독립 검토 경계를 유지한다.

`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`.
