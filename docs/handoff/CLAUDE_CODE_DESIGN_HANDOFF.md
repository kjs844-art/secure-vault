# KeyAtlas 디자인 협업 인계 — 2026-09-15

사용자가 디자인을 Claude Code와 진행한다고 알렸습니다. 이 문서는 디자인 결정이 아니라
제품 의도·기능 계약·동시 작업 경계를 공유하기 위한 기록입니다.

## 제품의 중심

어떤 로그인 계정으로 어느 서비스에 가입했고, 그 서비스에서 발급한 비밀번호/API 키/Secret을
어디에 연결했는지 관리하는 개인 보안 금고입니다. 단순 API 키 메모장이나 서비스 자동 수집기가 아닙니다.

화면에서 구분할 개념:

- 로그인 수단: Google / 카카오 / 네이버 / 이메일 등과 사용자가 구분하는 계정.
- 서비스 계정: 사용한 서비스, 가입·로그인 방법, 조직/프로젝트/환경, 기록 출처와 확인 상태.
- 자격 증명: 비밀번호, API 키, Secret 등. 소셜 로그인만 있으면 서비스 비밀번호가 없을 수 있음.
- 연결처: 앱, 플러그인, MCP 서버, CLI, 서버/CI 등과 사용자가 기록한 연결 관계.

“연결 기록 있음”은 현재 연결이 살아 있다는 검증 결과가 아닙니다. “모든 가입 서비스를 찾음”,
“모든 키 사용처를 확인함”, “소셜 연결을 끊으면 대상 서비스 계정도 삭제됨” 같은 표현을 쓰지 않습니다.
KeyAtlas 자체의 로그인과 금고에 기록하는 외부 서비스 로그인도 혼동하지 않게 표시합니다.

## 현재 실행 위치와 상태

- 실제 기능 작업 폴더: `C:\Users\USER\Documents\ChatGPT\KeyAtlas\secure-vault-session-hardening`
- 저장소: `https://github.com/kjs844-art/secure-vault` (확인 시 비공개)
- 기능 브랜치: `codex/firstvibe-local-session-hardening`
- `apps/web`: React/TypeScript/Vite, `/?view=local-vault`는 합성 금고, `/?view=synthetic-backup`은 합성 백업 연습.
- 현재 실제 Secret 입력, 소셜 계정 자동 조회, 운영 인증/DB, 결제, 공개 배포는 제공하지 않습니다.
- `SyntheticRegistrationPanel.tsx`와 `SyntheticVaultSession.register(selection)`이 연결됐습니다. 닫힌 프로필/자격증명/연결 ID만 받으며 임의 문자열·키 입력 칸을 추가하지 않습니다. 계정/workspace/project/환경은 사용자 로컬 목록과 검색에만 표시합니다. 실제 Comet의 등록/검색/잠금/재열기 검사는 [등록 화면 기록](../verification/2026-09-15-synthetic-registration-ui.md)을 확인하세요. 이는 최종 디자인이나 실제 키 입력 UI가 아닙니다.
- 상세 검증은 `docs/AUTONOMOUS_WORK_STATUS.md`와 `docs/verification/`의 최신 기록을 확인합니다.
- 후속 `editConnections(expectedGeneration, { reference, connectionIds })` 내부 경로는 검증됐지만 편집 UI는 아직 없습니다. 기존 이름으로 연결 ID를 임의 추론하거나 오래된 row에 최신 generation을 붙이지 마세요. UI 통합은 기능 담당자와 조율하며 [연결 편집 기록](../verification/2026-09-15-synthetic-connection-edit.md)의 snapshot 계약을 따릅니다.

현재 checkout의 `git status`, HEAD, 원격을 먼저 확인하세요. 상위 KeyAtlas 폴더의 별도
커밋 없는 저장소를 앱 저장소로 오인하거나 중첩 저장소 전체를 add하지 않습니다.

## 파일 소유권과 보안 경계

디자인은 별도 기능 브랜치/worktree에서 진행하고 유지할 이벤트/상태 계약을 확인합니다.
현재 앱 기능 담당자가 아래 파일을 변경 중일 수 있으므로 덮어쓰지 않고 먼저 조율합니다.

- `apps/web/src/features/local-vault/LocalVaultPanel.tsx` 및 세션/Worker/도구/백업 구현.
- `SyntheticRegistrationPanel.tsx`의 사용 확인·선택 순서·용량 gate와 세대별 초기화 계약.
- `apps/web/src/bridge/`와 `apps/web/src/storage/`의 입력·출력·저장 계약.
- `crates/`의 암호화·인증·코덱·저장 코어.

새 레이아웃/스타일에 붙일 때 기존 onClick/onSubmit/disabled, 오류 안내, 사용 확인,
자동 잠금, 열린 세대별 마운트/초기화와 빈 저장소만 복원하는 동작을 보존합니다.
디자인 폴더나 root CSS 변경도 공유 checkout에서 서로 덮어쓰지 않습니다.

실제 키를 샘플 데이터로 넣지 않습니다. 원격 폰트/이미지/favicon/분석 SDK/채팅 위젯을
금고 화면에 자동 추가하지 않습니다. 잠긴 화면에 이전 이름·검색어·목록을 남기지 않습니다.
로컬 결과 rows는 AI tool response가 아니며 모델이나 디자인 도구로 전송하지 않습니다.
네트워크·권한·암호화 설계 변경을 외형 수정에 섞지 않습니다.

## Git 백업 운영 — 사용자 요청

검증이 끝난 작업 단위마다 명시적으로 선택한 파일만 커밋하고 현재 기능 브랜치에
비강제 PUSH합니다. 미완성 체크포인트는 완료/출시 가능으로 표현하지 않고 남은 검사와
제한을 기록합니다. PUSH 이후 실제 원격 SHA를 확인합니다.

main 병합, 강제 PUSH, 다른 AI의 변경 삭제·덮어쓰기, 실제 비밀정보 업로드는 별도 승인 없이
하지 않습니다. `.env`, 사용자 금고/DB, 브라우저 프로필, node_modules와 빌드 산출물은 제외합니다.
다른 기기/AI 작업은 각자의 기능 브랜치에서 보존하며 통합 전에 diff와 회귀 결과를 검토합니다.
