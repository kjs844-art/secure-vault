# M01A 추가 분담 — 다른 AI에게 건넬 시작점

2026-09-28 KST. 사용자가 M01A의 일부를 추가로 나누고 현재 작업을 push하도록 요청했다.
**새 업무 3개는 배정 준비 상태다. 브랜치 생성이 구현 완료나 CI 성공을 뜻하지 않는다.**
기존 100개 번호 및 M02~M06을 대체하거나 다시 구현시키지 않는다.

## 공통 기준

- repo: https://github.com/kjs844-art/secure-vault
- 검증된 코드 기준: `32856a6eecfedf19848bffb63d77c84332955600` (HTTP checkpoint).
- 이후 배정 문서만 추가한 같은 출발점에서 아래 3개 브랜치를 발행한다.
- 작업 전 각 origin branch tip/로컬 HEAD/dirty 파일을 기록한다. 원격 조회 없이 옛 SHA를 최신이라고 부르지 않는다.
- PR base: `codex/firstvibe-mvp-01a-integration-20260927` (통합용). main에 직접 병합하지 않는다.
- 각 AI는 사용자에게 지정받은 업무 한 개/브랜치 한 개/별도 checkout을 사용한다.
- 코드 기준은 공유하지만 각 업무의 허용 파일은 겹치지 않는다. 공용 파일 변경 제안은 주 담당에게 보낸다.
- DB·도메인·호스팅·실제 배포는 사용자 재개 전 보류. 원본 benefit-validator/Lovable/DB 동결.
- `REAL_SECRET_GATE=CLOSED`. 합성 데이터만; 실제 계정/메일/API key/.env/로그 복사 금지.
- main merge, force push, 다른 AI의 reset/stash, Windows 보안 우회, 새 유료 서비스·새 도구/의존성 설치 금지.
  기존 lockfile에 고정된 의존성의 README 설치 절차만 허용하며 버전/manifest/lock은 변경하지 않는다.

## 새로 배정할 3개

| 번호 | 맡길 일 | 전용 브랜치 | 안내 |
|---|---|---|---|
| M01A-1A | 브라우저용 카탈로그 호출·응답 검증 모듈. 실제 UI/인증/운영 연결 제외 | `codex/firstvibe-mvp-01a-1a-catalog-client-20260928` | [1A 지침](M01A-1A.md) |
| M01A-2A | 합성 adapter를 실제 loopback HTTP로 조합하는 독립 QA | `codex/firstvibe-mvp-01a-2a-http-qa-20260928` | [2A 지침](M01A-2A.md) |
| M01A-3 | PR별 담당 변경·검사 근거·통합 순서 문서화 | `codex/firstvibe-mvp-01a-3-pr-ledger-20260928` | [3 지침](M01A-3.md) |

A는 보안 판단/난도가 있는 작업 표시다. 특정 모델을 강제하지 않는다.
세 작업은 서로 기다리지 않고 병렬 진행할 수 있다. 결과는 검토 후 M01A에서 선별 통합한다.
이제 첫 출시 배정은 기존 6개 + 새 3개 = **9개 업무**다. 저장소 전체 브랜치 수가 9개라는 뜻은 아니다.

## 주 담당이 계속 맡는 것

- 인증·동의·소유권·저장 완료 조건과 금고 보안 경계의 최종 코드 판단.
- M02 화면과 M03 관계 계약의 차이 검토, 앱 셸/route/공용 타입의 선별 통합.
- 제출된 회귀·독립 검토 결과 확인, 필요한 공통 수정, 최종 출시 가능 범위 판단.
- 실제 auth/DB/provider 연결은 사용자 환경 보류가 해제된 뒤 별도 검증한다.
- B05 실제 파일 다운로드→새 프로필 복원 등 남은 증거를 완료라고 과장하지 않는다.

주 담당은 새 1A/2A/3의 소유 경로에서 동시에 같은 업무를 구현하지 않는다.
추가 발견이 있으면 코드 변경 요구와 근거를 전달하고, 무단 일괄 merge하지 않는다.

## 기존 M02~M06 원격 상태: 2026-09-28 조회

모두 OPEN/main 대상이며 merge되지 않았다. PR 등록과 검증·통합 완료는 다르다.

| 업무 | PR / 당시 tip | 실제로 확인한 상태 |
|---|---|---|
| M02 | [#21](https://github.com/kjs844-art/secure-vault/pull/21), `e19ae37872a1cb2324d4c227593fbf57f8731667` | 데모 컴포넌트 제출. scaffold에 mount/build/browser 미검증 |
| M03 | [#17](https://github.com/kjs844-art/secure-vault/pull/17), `5fecb0f29ce56b2959b5350913247114ded8e8cf` | 연결 참조 계약/테스트 제출. 작성자 focused 32/32 기록; 주 담당 재검사 전 |
| M04A | [#16](https://github.com/kjs844-art/secure-vault/pull/16), `08c40b1d194ab92ca1b3cabbc069336ac51ad69e` | 초기 원본/기준 코드의 경계 검토 문서. 최신 M01A 코드 재검토와는 다름 |
| M05A | [#18](https://github.com/kjs844-art/secure-vault/pull/18), `e6e5700d5931a1ce37f93f83049e5cc145e46021` | 브라우저 QA 스크립트/기록 제출. 작성자 5/5 기록; 제한·NOT_RUN 항목 있음 |
| M06 | [#20](https://github.com/kjs844-art/secure-vault/pull/20), `e032e49593d64c4917aedaa89454fcace264a202` | 배정 handoff 1개만 확인. docs/deployment/mvp 산출물 없음; 실환경은 보류 |

각 PR의 전체 main diff에는 이전 공통 작업도 포함된다. 파일 수/커밋 수를 담당 완료량으로 세지 않는다.
다섯 PR의 CI는 공통 `Windows PowerShell 5.1` Secret 스캐너 회귀 단계에서 실패했고 이후 Rust/web는
실행되지 않았다. 초기 Secret scan/PS7는 성공했다. 상세 로그 없이 내부 실패 원인을 확정하지 않는다.
현재 M01A 직전 `51f07f5`의 두 CI는 통과했지만, 그것이 다른 PR이나 새 HTTP 코드의 CI 성공은 아니다.

## 공통 전달 문장

아래에서 번호와 파일 하나만 선택해서 보낸다. 세 개를 한 AI에게 동시에 맡길 필요는 없다.

> KeyAtlas의 M01A 추가 분담 중 지정한 업무 하나를 맡아 주세요. 해당 전용 브랜치의
> docs/handoff/mvp-20260927/M01A-1A.md, M01A-2A.md 또는 M01A-3.md 중 배정받은 파일과
> M01A_DELEGATION.md를 읽고 그 범위만 진행하세요. 원격 tip/작업 경로를 확인하고 다른 변경은
> 보존하세요. 완료 보고에는 branch/SHA/변경 파일/정확한 검사 명령과 exit/미검증 항목을 넣으세요.
> 코드 완료·push·PR·CI·merge·배포를 구분하고, 검증 후 지정 브랜치에 push 및 M01A 대상 Draft PR로
> 제출하세요. main merge, 실제 Secret/메일/DB, 도메인·호스팅·배포 작업은 하지 마세요.

## 검증 명령

코드 업무는 `apps/benefits-web`에서 `npm test`, `npm run build`, `npm run typecheck`,
`npm run check:boundaries`, `npm run test:smoke`를 실행한다. 아직 설치하지 않은 환경에서만
lockfile을 확인한 뒤 기존 README의 설치 절차를 따른다. 새 의존성은 추가하지 않는다.
repo root에서 Secret scanner와 `git diff --check`를 실행한다. 문서 업무는 로컬 링크도 확인한다.
검사 실패를 숨기거나 CI를 skip/완화해서 성공으로 만들지 않는다.

이번 배정 발행 자체는 새 PR 3개를 만든다는 뜻이 아니다. 각 AI가 실제 산출물을 낸 뒤 PR로 제출한다.

## 이번 배정 문서의 검사 기록

- 독립 읽기 검토: 소유 경로/PR base/보류 조건을 확인하고 설치·타 브랜치 금지 문구를 명확히 했다.
  최신 PR 전체 코드의 충돌 검사나 새 세 업무의 구현 검증은 아니다.
- umbrella `scripts/check-markdown-links.ps1 -Root <문서>`: 새 인계 4개와 M01A/START_HERE/SESSION_HANDOFF,
  총 7개 파일 각각 exit 0. 외부 URL 가용성 검사는 아니다.
- repo `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1`:
  SECRET_SCAN_PASSED, baseline 4, REAL_SECRET_GATE=CLOSED, exit 0.
- `git diff --check`: exit 0. 코드 체크포인트의 검사 결과는 HTTP 검증 기록에 별도로 있다.
