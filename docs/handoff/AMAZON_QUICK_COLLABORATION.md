# Amazon Quick / Spark 협업 경계

기준: 2026-09-15. 연결 안내이며 계정 연결·권한 부여·유료 구독·배포 완료 기록이 아니다.
사용자 후속 요청으로 Amazon 연결 작업은 보류했다. 아래 내용은 재개 시 참고할 초안이다.
`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`.

## 같은 프로젝트에서 협업하는 방법

저장소: [kjs844-art/secure-vault](https://github.com/kjs844-art/secure-vault).
현재 기능 기준 브랜치: `codex/firstvibe-local-session-hardening`.
로컬 작업: `C:\Users\USER\Documents\ChatGPT\KeyAtlas\secure-vault-session-hardening`.
작업 시작 전에 원격 브랜치의 최신 SHA를 확인한다. 미커밋 로컬 변경은 Quick에서 보이지 않는다.

```text
기능/보안 담당 ── 별도 기능 브랜치 ─┐
Claude Code   ── 디자인 브랜치 ────┼─ GitHub diff/PR → 통합 검증 → 승인된 병합
Quick/Spark   ── 소규모 작업 브랜치 ┘
```

| 담당 | 맡길 범위 | 맡기지 않는 범위 |
|---|---|---|
| 핵심 구현 담당 Codex | 암호화·인증·복구·저장·충돌 처리·통합 회귀 | 사용자 계정/도메인/과금 결정 |
| Claude Code | 별도 합의한 화면·스타일 | 잠금·원문·네트워크·저장 계약 변경 |
| Amazon Quick | 문서 읽기, 요구사항/이슈/QA 초안, PR 설명 검토 | 자체 테스트 실행 증거 없는 통과 선언, 핵심 보안 수정 |
| Spark | 지정한 문서 한 파일, 작은 보조 작업 | 코어/의존성/CI/권한/배포 변경 |

AI 수에 비례해 일정이 줄어들지는 않는다. 검증·복구 훈련·사용자 결정은 별도이며,
작업 파일과 기준 SHA를 나눠 중복 작성과 통합 재작업을 줄이는 것이 목표다.
각 도구는 이 채팅 기억이나 로컬 프로세스를 자동 공유하지 않는다.

## Quick 연결에서 주의할 점

AWS 공식 문서상 GitHub 연동은 MCP를 통한 파일·이슈·브랜치·PR 작업을 제공한다.
이 연결 자체가 로컬 clone이나 Cargo/Node 실행 환경을 제공한다는 증거는 아니다.
[GitHub integration](https://docs.aws.amazon.com/quick/latest/userguide/github-integration.html)

MCP 안내에는 원격 서버와 인증 구성이 필요하며 Enterprise 구독이 전제 조건으로 기재돼
있다. 계정에서 실제 제공되는 옵션/비용을 확인하고, 결제나 구독 변경은 별도 승인한다.
[MCP integration](https://docs.aws.amazon.com/quick/latest/userguide/mcp-integration.html)

현재 화면의 `Custom OAuth app`은 직접 준비한 OAuth 클라이언트 정보를 요구한다.
Client ID는 GitHub 아이디나 저장소 이름이 아니며 Client Secret은 AI API 키가 아니다.
MCP Base URL 칸에 저장소 URL을 넣지 않는다. 콜백 URL을 추측하지 않는다.
우선 Auth configuration의 실제 선택지를 확인한 뒤 해당 인증 방식으로 안내한다.

첫 연결은 읽기 위주로 제한한다. GitHub 측에서도 가능한 인증 방식으로 이 저장소에만
접근하도록 제한한다. 프롬프트의 파일 제한은 강제 접근 제어가 아니며, OAuth 방식에 따라
권한이 더 넓을 수 있으므로 승인 화면을 확인한다. merge/delete/admin 동작은 허용하지 않는다.
토큰/Client Secret은 공식 인증 화면에만 입력하며 채팅·문서·Git에 남기지 않는다.

## Quick에 줄 첫 작업 프롬프트

```text
KeyAtlas 프로젝트의 읽기 전용 문서 보조 역할이다.
저장소 kjs844-art/secure-vault, 기준 브랜치 codex/firstvibe-local-session-hardening.
먼저 실제 접근 가능한 브랜치와 HEAD SHA를 보고하라. 접근 불가면 추측하지 말라.
docs/MVP.md, docs/AUTONOMOUS_WORK_STATUS.md,
docs/handoff/CLAUDE_CODE_DESIGN_HANDOFF.md와 관련 최신 verification 문서를 읽고,
초보 사용자가 알아야 할 '현재 가능한 것 / 아직 안 되는 것'을 각 5줄 이내로 작성하라.
계획 문서와 실제 실행 증거를 구분하고 근거 파일을 연결하라.
파일·브랜치·이슈·PR 생성/수정, merge, 외부 사이트 호출, 키 입력은 하지 말라.
테스트를 실행하지 못했다면 '미실행'이라고 써라.
실제 Secret 입력은 금지되어 있고 데모는 합성 데이터 전용이다.
```

## Spark에 줄 작은 작업 프롬프트

```text
KeyAtlas의 문서 목차 정리만 맡는다. 보안/암호화 코드 작업은 하지 않는다.
저장소 kjs844-art/secure-vault의 codex/firstvibe-local-session-hardening을 기준으로
기준 SHA를 기록하고 별도 worktree/clone에서 작업하라. 공유 작업 폴더의 브랜치를 바꾸지 말라.
작업 브랜치는 codex/firstvibe-spark-doc-index. 이미 있으면 기존 작업 여부부터 확인하라.
담당 파일은 docs/README.md 하나뿐이다. 기존 파일/다른 AI 변경이 있으면 덮어쓰지 말고 보고하라.
MVP, AUTONOMOUS_WORK_STATUS, PRODUCT_BUILD_AND_DEPLOY_GUIDE,
SECURITY_ARCHITECTURE, 최신 verification, 디자인 handoff 문서의 목차를 100줄 이내로 작성하라.
각 문서의 목적과 읽을 순서를 짧게 쓰고 '설계/계획'과 '실제 검증'을 구분하라.
모든 상대 링크의 파일 존재를 확인하고 git diff --check를 실행하라.
코드·의존성·CI·보안 정책·다른 문서는 바꾸지 말고 비밀정보를 읽거나 넣지 말라.
변경 파일, 검사 명령/exit code, 미검증 내용을 보고하고 커밋/푸시 권한을 별도로 확인하라.
main 병합과 강제 푸시는 금지다. 테스트를 안 했으면 통과했다고 쓰지 말라.
```

연결 후 작은 읽기 작업이 정확한 브랜치/파일을 반환하는지 확인한 다음 쓰기 범위를 협의한다.
