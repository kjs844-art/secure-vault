# Aardvark / Codex Security 신청 준비

확인일: 2026-08-29 KST (공식 문서 재확인)  
첨부 화면: `Aardvark_신청화면_참고.png`

## 스크린샷 판정

첨부 화면의 제목과 설명은 OpenAI 공식 `Aardvark Private Beta Interest Form`의 상단과 일치한다. 따라서 스크린샷은 신청 화면이 맞다.

다만 현재 중요한 변경이 있다.

- Aardvark는 2025년 공개된 private beta 이름이다.
- OpenAI는 2026-03-06에 Aardvark가 **Codex Security**가 됐고 research preview로 전환됐다고 공지했다.
- 현재 공식 OpenAI Docs는 Codex Security를 plugin, CLI, TypeScript SDK, cloud 형태로 안내하며, cloud는 research preview이고 연결된 GitHub 저장소를 대상으로 한다. 실제 scan에는 계정별 Codex Security access가 필요하다.
- 예전 Aardvark 폼 URL은 2026-08-29 현재 열리지만, 구형 beta intake일 가능성이 있다.

공식 링크:

- [Aardvark 비공개 베타 신청 폼](https://openai.com/form/aardvark-beta-signup/)
- [Aardvark가 Codex Security로 전환됐다는 공지](https://openai.com/index/codex-security-now-in-research-preview/)
- [Codex Security 공식 문서](https://learn.chatgpt.com/docs/security)

## 신청 가능한가?

**답: 신청서 초안 작성은 가능하고, 구형 폼도 현재 접근 가능하다. 다만 지금은 사용 중인 ChatGPT 계정에서 Codex Security를 먼저 여는 경로가 우선이며, 구형 폼 제출이 접근 권한이나 선정을 보장하지 않는다.**

기존 폼의 필수 조건:

1. GitHub Cloud(`github.com`) integration
2. beta 기간 동안 사용하고 qualitative feedback 제공
3. OpenAI 약관·제품 정책·beta agreement 준수

KeyAtlas 원격은 `https://github.com/kjs844-art/secure-vault.git`이므로 GitHub Cloud 조건은 맞는다. 나머지는 사용자가 실제 계정 정보와 동의 여부를 확인해야 한다.

이 환경에 Codex Security 관련 plugin/skills가 설치돼 있는 것은 확인되지만, 그것만으로 사용자의 cloud research-preview entitlement가 승인됐다고 말할 수는 없다.

## 신청서 입력표

| 필드 | 현재 작성 가능한 내용 |
| --- | --- |
| Organization name | 개인 프로젝트라면 실제 상황에 맞게 `KeyAtlas (independent project)` 후보. 허위 회사명 금지 |
| OpenAI OrgID | 사용자가 OpenAI Platform에서 직접 확인 |
| Organization type | 폼의 실제 선택지에서 사실대로 선택 |
| Contact name/email | 사용자의 실제 정보 입력 |
| Role/department | 실제 역할·부서 입력. 개인 개발자면 폼 선택지 확인 |
| Number of repositories | 신청 조직의 실제 GitHub 저장소 수 입력. 임의 추정 금지 |
| Largest codebase | 현재 KeyAtlas Rust `.rs` 약 15,676줄 측정. 해당 저장소는 `<100k` 후보 |
| Languages/frameworks | Rust, SQLite/rusqlite. 실제 폼에서 Rust 선택 |
| Dedicated security staff | 사실대로 선택. 임의로 Yes/No 결정하지 않음 |
| Codebase description | 아래 영문 초안 |
| Why pilot | 아래 영문 초안 |

LOC는 현재 `crates` 아래 Rust 파일만 센 값이다. 제출 직전 폼이 요구하는 LOC 산정 기준을 다시 확인한다.

## Codebase description — 254자

> KeyAtlas is an experimental Rust security core for a ciphertext-only SQLite vault. It uses synthetic encrypted records to test local persistence, WAL/SHM handling, locking, crash safety, and TOCTOU resistance. No real secrets or production data are used.

## Why do you want to pilot? — 236자

> We want to pilot Codex Security on a synthetic-only Rust/SQLite security core to identify design and implementation risks, especially file identity, concurrency, WAL/SHM, and TOCTOU issues. We can provide focused, reproducible feedback.

두 답변 모두 기존 300자 제한 안에 들어간다. 제출 시 폼의 실제 카운터로 다시 확인한다.

## 제출 전에 사용자가 직접 준비할 것

- OpenAI OrgID
- 실제 이름과 이메일
- 실제 역할·부서
- 조직 유형
- 실제 GitHub repository 수
- 전담 보안 인력 여부
- beta agreement와 data policy 동의 여부
- Codex Security가 현재 계정에서 이미 열리는지 확인

## 안전한 제출 원칙

- KeyAtlas를 production-ready라고 쓰지 않는다.
- synthetic-only와 unresolved TOCTOU를 숨기지 않는다.
- 실제 Secret, `.env`, SQLite 실데이터를 폼이나 저장소에 넣지 않는다.
- GitHub 연결 권한은 필요한 repository만 최소 범위로 검토한다.
- 제출 전 beta agreement와 코드 데이터 처리 조건을 직접 읽는다.

## 현재 권고

먼저 현재 ChatGPT 계정에서 공식 Codex Security 시작 화면을 열고 GitHub repository 연결 가능 여부를 확인한다. 계정에서 보이지 않거나 OpenAI가 별도 신청을 요청할 때에만 구형 Aardvark 폼을 보조 경로로 검토한다.

실제 제출 버튼은 계정과 외부 상태를 바꾸므로, 개인정보 필드를 사용자가 채우고 최종 내용을 확인한 뒤 별도 승인받아 진행한다.
