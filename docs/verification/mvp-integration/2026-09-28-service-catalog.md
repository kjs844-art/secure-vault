# M01A — 서비스 카탈로그와 화면 데이터 검증

2026-09-28 KST. worktree: `agent-staging/keyatlas-mvp-01a-20260927`.
브랜치: `codex/firstvibe-mvp-01a-integration-20260927`.
시작 로컬 HEAD `24d47e17bfc395c56817a7600676756996db7682`, clean.
실제 원격은 `3c25df606d91a5cba716d251f9d463a4f3c96278`로 이전 수신함 commit은 로컬에만 있었다.
기존 CI가 끝날 때까지 취소 없이 같은 run을 관찰한 뒤 검증된 두 체크포인트를 함께 push한다.

## 변경 파일과 범위

- `apps/benefits-web/src/server/catalog/{contracts,validation,service-catalog}.ts`:
  owner-scoped create/update/remove/get/list, 정확한 입력, current-row replay, CAS/collection revision.
- `src/server/review/{contracts,review-service,validation}.ts`: 서비스 변경 전 버전 commit 조건,
  카탈로그와 같은 직렬화 경계 의무, 기존 label/date 검증 함수 공유.
- `src/server/review/presentation.ts`: 권한 확인된 내부 receipt의 명시적인 화면 필드 투영.
- `src/domain/reviewed-benefit-view.ts`: 엄격한 decoder, scope/generation/revision reducer.
- `tests/service-catalog.test.ts`, `tests/reviewed-benefit-view.test.ts`, 기존 review type 회귀,
  `tests/support/review-memory-store.ts`: 공유 합성 adapter와 새 연결/충돌/프라이버시 회귀.
- `scripts/check-boundaries.mjs`, 앱 README/계약 및 M01A/START_HERE/SESSION_HANDOFF/이 기록.

원본 benefit-validator/Lovable/DB, 기존 vault/Rust, M02 예약 UI, 다른 worktree는 수정하지 않았다.
실제 DB 프로젝트/파일/migration, OAuth, 메일, Secret, 도메인/배포 설정을 만들거나 사용하지 않았다.

## 연결한 범위

합성 메모리 adapter로 서비스 생성 → 후보 preview/confirm → 안전한 receipt 투영 → 화면 상태
reducer → 혜택 삭제 → 늦은 saved 응답 무시 → 서비스 삭제를 실제 내부 코드로 연결했다.
이름 변경이 이전 preview를 무효화하고, live 혜택이 남으면 서비스 삭제가 거절되는지 검사했다.
동시 confirm/update/delete의 순서와 commit 직전 서비스 버전/참조 변경도 합성 조건으로 확인했다.

서비스 이름/요금제/상태는 user-reported, accountProof는 not-established다.
기존 이름이 같은 계정을 자동 병합하지 않으며 nullable timezone/날짜를 임의로 채우지 않는다.
서비스 삭제는 혜택이나 메일 후보의 자동 cascade가 아니다. 원본 메일 삭제도 아니다.

화면 데이터는 내부 operation/session/grant/mailbox/candidate/analysis ID와 원문을 제외한다.
원래 관찰일·사용자 수정 관찰일을 구분하고 null/정밀도/부분 메일 경고를 보존한다.
요청 시작 시 캡처한 scope를 먼저 검사하므로 generation이 같은 계정 간 응답도 구별한다.
삭제 표식은 높은 saved revision으로도 부활하지 않는다. 실제 UI 연결은 아직 없다.

## 독립 검토

- 별도 읽기 담당이 catalog/review 계약과 코드를 검토했다. 서비스 삭제와 혜택 확인의
  원자적 참조 조건을 필수로 정했고, 변경 전 버전 조건이라는 뜻을 코드 주석에 명시했다.
- 다른 담당이 DTO/reducer를 구현했고 읽기 담당이 개인정보/날짜/scope/tombstone을 재검토했다.
- 별도 테스트 담당이 공유 메모리 adapter와 catalog 회귀를 작성했다.
- 검토에서 최종 소스의 확정 차단 결함은 발견하지 못했으나 전체 보안 감사나 실제 DB 검증은 아니다.

agent-consent-patterns의 정확한 명령·별도 결정·권한 최소화·정직한 receipt 원칙을 적용했다.
사용자 보고를 실제 계정 증명으로 승격하지 않았고, 삭제를 몰래 cascade하지 않았다.
UI 라이브러리/최종 디자인을 추가하지 않았다.

## 검사 결과

Node 24.19.0/npm 11.17.0. 아래 앱 명령은 `apps/benefits-web`에서 실행했다.

| 명령 | 결과 |
|---|---|
| `node --import tsx --test tests/service-catalog.test.ts` | 담당 검사 188/188, exit 0 |
| `node --import tsx --test tests/reviewed-benefit-view.test.ts` | 담당 검사 20/20, exit 0 |
| `node --import tsx --test --test-reporter=spec tests/reviewed-benefit-view.test.ts tests/review-service.test.ts tests/review-expiry.test.ts` | 주 담당 재검사 240/240, exit 0 |
| `npm test` | 주 담당 전체 969/969, fail/cancel/skip 0, exit 0 |
| `npm run build` | client/SSR/Nitro/TypeScript, exit 0 |
| `npm run typecheck` | 최종 테스트 추가 후 재실행 exit 0 |
| `npm run check:boundaries` | source 25/client 4, exit 0 |
| `npm run test:smoke` | loopback SSR/assets 4, CLOSED, exit 0 |
| `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1` | SECRET_SCAN_PASSED, baseline 4, CLOSED, exit 0 |
| umbrella `check-markdown-links.ps1 -Root <변경 Markdown>` | 7개 파일의 로컬 상대 링크, 각 exit 0 |
| `git diff --check` | exit 0 |

초기 타입 검사에서 새 동기 메서드를 쓰기 메서드 union에서 제외하지 않은 오류 1개가 있었다.
테스트의 WriteMethod에서 requireServiceVersion을 제외했고 최종 타입/전체 회귀는 통과했다.
문서 검사 스크립트는 이 worktree가 아니라 umbrella의 `scripts/check-markdown-links.ps1`을 사용한다.

로컬 Rust 전체 회귀는 이번 변경에서 재실행하지 않았다. Rust/vault source는 변경하지 않았다.
HTTP smoke는 브라우저 hydration나 실메일 E2E 증거가 아니다. bundle 검사는 완전한 보안 감사가 아니다.

## 원격과 완료의 구분

시작 원격 SHA `3c25df6`의 기존 run 두 건을 같은 handle로 조회했고 **completed/success**를 확인했다.

- [run 36362044099](https://github.com/kjs844-art/secure-vault/actions/runs/36362044099)
- [run 36362040475](https://github.com/kjs844-art/secure-vault/actions/runs/36362040475)

이는 이전 SHA의 CI이며 새 catalog/inbox 체크포인트의 원격 검사 성공을 뜻하지 않는다.
10:23 KST 실제 원격 SHA가 여전히 `3c25df6`임을 확인했고 branch/main 대상 기존 PR은
[#19](https://github.com/kjs844-art/secure-vault/pull/19)다. 비강제 push 후 새 run/SHA는 별도로 확인한다.
main은 병합하지 않는다.

## 남은 것

- 실제 UI·auth 문맥에 fresh scope/요청 시 캡처·한도 안내를 연결하고 브라우저 E2E로 확인.
- 실제 auth/DB/provider adapter, HTTP body/streaming 한도, CSRF/rate limit, RLS/격리/내구성.
- 후보 전체 목록 pagination, 재분석 stable source 연결, process 재시작 handoff.
- 계정 전체 삭제·물리 보존 정책·백업과 장애 복구, B05 실제 파일 다운로드/새 프로필 복원 증거.
- DB/도메인/호스팅/배포 실설정은 사용자가 명시적으로 재개할 때까지 보류한다.

현재 reducer 1,000개와 서비스 페이지 50개는 기술적 한도이지 유료 플랜 제한이 아니다.
구현/검증한 내부 코드와 실제 서비스 운영 완료를 구분한다. `REAL_SECRET_GATE=CLOSED`.
