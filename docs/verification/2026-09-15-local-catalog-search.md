# 2026-09-15 로컬 금고 관계 검색

작업 브랜치: `codex/firstvibe-local-session-hardening`, 시작 커밋 `444e9ff`.
도메인·디자인 재설계·외부 계정·배포·결제를 결정하지 않고 기존 기능 화면에 로컬 검색을 연결했다.

## 사용자 흐름

```text
암호문 복원 → 검증된 표시 메타데이터 → 서비스/항목/연결처 검색
                                           ├─ 연결 있음/없음/MCP 분류
                                           └─ 결과 수/유형/상태/연결 이름
잠금 → 목록·검색 화면 제거 → 다시 열기 → 새 세대, 검색어·분류 초기화
```

검색은 외부 서비스의 실제 사용처 자동 탐지가 아니다. 원래 합성 메타데이터를 필터링한다.
현재 fixture는 3개이며 실제 키 원문 검색/보기/입력 기능은 추가하지 않았다.

## 코드

- `searchLocalCatalog.ts`: 허용된 표시 필드만 읽는 순수 함수, NFKC/대소문자 정규화, 공백별 AND 검색, 부분 문자열의 리터럴 검색. 최대 256 UTF-16 코드 단위. 초과 입력은 잘라서 다른 질의로 바꾸지 않고 결과 없음 처리.
- `LocalCatalogSearch.tsx`: 검색어/연결 분류/결과 수/빈 결과. URL·스토리지·전송·로그 기능 없음. React 텍스트 렌더링 사용.
- `LocalVaultPanel.tsx`: 열린 상태에서만 검색 컴포넌트 마운트. 기존 목록의 하드코딩된 API 키 표시를 실제 credential type의 표시명으로 대체.
- `SyntheticVaultSession.ts`: 저장 ID/인증 토큰이 아닌 로컬 `viewGeneration` getter. 빠른 lock/open을 React가 한 번에 렌더링해도 새 key로 검색 상태를 폐기하도록 연결.
- 검색·렌더링 검사 29개, view generation 검사 1개 추가. 기존 자동 잠금 및 저장소 회귀 검사는 유지.

## RED 중심

| 실패 위험 | 구현/검사 | 한계 |
|---|---|---|
| 모델의 새 secret/notes 필드가 자동 검색됨 | 명시적 필드 허용목록, 추가 getter를 읽으면 실패하는 테스트 | 입력은 기존 Worker 검증을 통과한 snapshot을 전제로 함 |
| 복잡한 입력이 정규식으로 실행됨 | 사용자 질의를 regex로 만들지 않고 includes로 처리 | 매우 큰 catalog의 UI 가상화는 후속 과제 |
| 필터 결과의 번호를 새 authorization ID처럼 사용 | snapshot reference/원래 순서 유지 | reference는 권한 증명 수단이 아님 |
| 문자열이 마크업으로 해석됨 | React escape 렌더링 검사 | 배포 origin/공급망 보안 감사는 별도 |
| 잠금 후 이전 검색어가 재등장 | 세대별 React key 및 조건부 마운트 | JS heap·OS 입력 기록·브라우저 확장 삭제를 보장하지 않음 |
| 검색어를 서버/AI/평문 저장소에 기록 | 순수 검색 함수와 메모리 상태만 사용, form submit/URL 저장 없음 | 같은 origin의 악성 JS에 대한 격리 수단은 아님 |

## 확인한 결과

- `npm run typecheck`: 종료 코드 0.
- `npm test -- --maxWorkers=1`: 최종 7개 파일, 213개 통과, 실패 0, 종료 코드 0.
- `npm run build`: TypeScript/Vite 및 실제 Worker/WASM asset 포함, 종료 코드 0. 이후 변경은 테스트의 fixture를 실제 open 상태로 강화한 것뿐이며 최종 213개 테스트를 재실행했다.
- `git diff --check`: 종료 코드 0.

### 브라우저 증거와 미검증

agent-browser 스킬의 격리 세션과 snapshot/ref 흐름으로 `http://127.0.0.1:4187/?view=local-vault`의 로컬 production preview를 확인했다. 새 합성 금고 생성 후 실제 IndexedDB/Worker/WASM을 거쳐 `전체 3개 중 3개`, 검색 input, 연결 분류 및 3개 관계 항목이 표시되는 것을 확인했다.

이후 검색 입력에서 도구 통신 오류 `os error 10060`, 조건 대기 timeout이 발생했다. `doctor --offline --quick`도 완료 결과 없이 대기하여 해당 진단 작업만 중단했다. 대체 CUA 경로 역시 실행 timeout이었다. 따라서 실제 브라우저의 검색 결과 변화, 초기화, 잠금/재열기, 모바일 동작은 **통과로 기록하지 않는다**. 최종 view-generation 보강 후의 브라우저 재검증도 남아 있다.

이번 격리 browser session은 close 성공 응답을 확인했다. 직접 실행한 preview/diagnostic command session만 중단했고, 4187 listener가 남아 있지 않음을 확인했다. 다른 사용자 브라우저/IDE/서버는 종료하지 않았다.

## BLUE 및 후속

서버/API/AI 전송 경로를 만들지 않고 원문 없는 기존 로컬 projection을 재사용한다. 검색 상태의 범위를 열린 금고 세대로 제한했다. 실제 사용자 인증·원문 저장·운영 데이터 복구·네이티브 전체 회귀·독립 제품 보안 리뷰는 아직 완료되지 않았다.

`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`. 전체 자율 작업 목표는 active다.
