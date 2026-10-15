# M01A — 메일 후보 수신함 연결 검사

2026-09-28 KST. 대상 worktree: `agent-staging/keyatlas-mvp-01a-20260927`.
브랜치: `codex/firstvibe-mvp-01a-integration-20260927`.
시작 HEAD/실제 origin: `3c25df606d91a5cba716d251f9d463a4f3c96278`, clean 확인.
이전 목표 턴은 확인·삭제 제어 구현/검증/비강제 push로 진전이 있었다.
이번에도 DB·도메인·배포 보류를 유지하며 provider 독립 내부 연결만 진행했다.

## 변경 범위

- `apps/benefits-web/src/server/mail/run-analysis.ts`: sessionRevision/dataGeneration을
  raw authority/반복 guard/quota permit에 결합. 실제 성공 객체만 private WeakMap에 등록.
- `src/server/inbox/contracts.ts`, `validation.ts`, `candidate-inbox.ts`: stage/listBatch/discard,
  별도 저장 동의, batch 완료/빈 batch, canonical SHA256 동등성/중복 확인, 현재 상태 재생.
- `src/server/review/contracts.ts`, `review-service.ts`, `validation.ts`: 후보 pending 접근 기한,
  preview/commit 기한 및 최종 응답 만료 검사, 공통 exact-field 파서 공유.
- tests: mail 실행 회귀 보강, inbox 118개, 입력 검증 14개, review 만료 26개;
  테스트 전용 메모리 adapter의 batch/unique slot/기한/두 grant commit 조건 추가.
- `scripts/check-boundaries.mjs`: 새 inbox/staging/private handoff marker의 client bundle 혼입 검사.
- 앱 계약/README 및 M01A/START_HERE/SESSION_HANDOFF, 이 검사 기록.

기존 vault/Rust, M02 예약 UI, 원본 benefit-validator/Lovable/DB, 다른 worktree는 수정하지 않았다.
새 DB 파일/migration/계정/도메인/외부 API/실제 메일·Secret을 만들거나 사용하지 않았다.

## 실제 연결을 검증한 범위

합성 메일을 **실제 내부 runner → 정규화 → 후보 검증 → WeakMap handoff → stage → list →
review preview → confirm → remove**로 통과시켰다. DB/인증/provider만 메모리 fixture이며
runner 결과를 수제 구조체로 바꿔 파이프라인 검사를 대신하지 않았다.

등록되지 않은 복사본·실패 결과의 stage를 거부하며 분석 당시 소유권을 새 세션/세대에
사후 부착하지 않는다. 저장 동의는 분석 동의와 별도다. stage는 commit 전후에 권한을
재확인하고 실제 commit 조건은 어댑터가 원자적으로 강제해야 한다.

accepted/deleted/expired 후보의 예전 본문은 재생하지 않는다. 빈 batch도 완료 기록을 남긴다.
동일 operation의 내용/권한/저장 grant 변경은 충돌이다. 새로운 분석에서 같은 메일을 다시
제안하는 것을 영구 방지한 것은 아니며, stable source mapping은 아직 남아 있다.

기한 지난 pending도 사용자가 폐기할 수 있다. 이전 pending 접근 기한이 지나도 accepted
혜택은 유지되며 기존 삭제 경로로 삭제할 수 있다. 접근 만료는 물리 삭제/보존 정책 완료가 아니다.

## 독립 검토 및 수정

- 설계 검토에서 분석 결과의 owner/session revision/generation 누락을 확인했다.
  원본 결과의 process-local private binding과 모든 단계의 명시적 revision을 추가했다.
- 확인 preview가 commit 후 응답 대기 중 만료돼도 본문을 반환하는 결함을 수정했다.
  동일 합성 진단에서 `REVIEW_PREVIEW_EXPIRED`, payload 없음, commit 1/rollback 0, exit 0.
  이미 commit했을 수 있으므로 오류를 rollback 성공이라고 표시하지 않는다.
- stage에서도 마지막 앱 권한 조회의 지연이 분석/저장/pending deadline을 넘기면
  최종 결과를 차단한다. 각각의 기한 회귀는 commit 1/rollback 0과 함께 검사했다.
- calendar 값의 native RangeError를 고정 입력 오류로 정리하고 잘못된 clock을 거절했다.
- mail runner 식별자 끝의 LF/CRLF/공백도 거부한다. 옵션/권한의 6개 필드에 대해
  binding을 동일하게 맞춘 18가지 경우에서도 quota/mailbox/analysis가 호출되지 않는지 검사했다.
- inbox transaction 계약에 stage뿐 아니라 list/discard의 app auth entry/commit 검사와
  commit 완료 후 반환 의무를 명시했다.

agent-consent-patterns의 목적별 별도 동의·권한 최소화·기한·철회 후 정리 가능성과
정직한 action receipt 원칙을 적용했다. 추가 독립 검토에서 확정 차단 결함을 발견하지 못했으나,
전체 보안 감사 또는 실제 제공자 동의 검증은 아니다.

## 실행한 검사

Node 24.19.0/npm 11.17.0. 앱 명령은 `apps/benefits-web`에서 실행했다.

| 명령/범위 | 결과 |
|---|---|
| `node --import tsx --test tests/run-analysis.test.ts` | 255/255, exit 0 |
| `node --import tsx --test tests/candidate-inbox.test.ts` | 118/118, exit 0 |
| `node --import tsx --test tests/inbox-validation.test.ts tests/review-expiry.test.ts` | 40/40, exit 0 |
| `npm test` | 761/761, fail/cancel/skip 0, exit 0 |
| `npm run build` | client/SSR/Nitro/TypeScript, exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run check:boundaries` | source 20/client 4, exit 0 |
| `npm run test:smoke` | loopback SSR/assets 4, CLOSED, exit 0 |
| `check-markdown-links.ps1 -Root <각 변경 Markdown>` | 문서 9개의 로컬 상대 링크, 각 exit 0 |
| `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1` | SECRET_SCAN_PASSED, baseline 4, CLOSED, exit 0 |
| `git diff --check` | exit 0 |

로컬 Rust 전체 회귀는 이 변경에서 재실행하지 않았다. Rust/vault source는 변경하지 않았다.
HTTP smoke는 새 화면/브라우저 hydration/실메일 E2E 증거가 아니다.
정적 bundle 검사는 보안 감사/네트워크 sandbox가 아니며 새 controller는 공개 route에 연결하지 않았다.

## Git/원격 검사 구분

이 턴 시작 SHA `3c25df6`의 기존 실행을 같은 handle로 재조회했다.

- [run 36362044099](https://github.com/kjs844-art/secure-vault/actions/runs/36362044099)
- [run 36362040475](https://github.com/kjs844-art/secure-vault/actions/runs/36362040475)

09:46 KST 관찰에서 두 실행 모두 `in_progress`, Rust workspace verifier 단계, 실패 단계 없음.
이 관찰은 현재 새 inbox 코드의 원격 CI 통과가 아니다. 검증된 파일을 명시적으로 commit하고,
기존 검사를 새 push로 취소하지 않도록 같은 run의 종료와 원격 SHA를 확인한 뒤 push한다.

## 남은 것과 다음 구현

- 서비스 생성·조회, 안전한 UI projection, 지연된 응답 generation/revision fence, 화면 연결.
- 전체 후보 목록의 bounded pagination, 자동 물리 삭제·전체 계정 purge·운영 보존 정책.
- 다른 분석 간 stable source 연결, process/worker 재시작 handoff·crash/commit 결과 대조.
- 실제 auth/DB/provider 어댑터, streaming/HTTP body 한도, CSRF/rate limit, RLS/내구성/실 E2E.
- B05 실제 파일 다운로드→새 프로필 복원 증거는 별도 미완료이며 이 검사로 대신하지 않는다.

현재 7일은 pending 접근의 기술적 상한일 뿐 자동 보관 정책·물리 삭제 스케줄이 아니다.
사용자가 재개하기 전 실제 DB·도메인·배포는 보류한다. 원본 환경 공유로 우회하지 않는다.
`REAL_SECRET_GATE=CLOSED`. 기능 전체·M01A 전체·서비스 배포 완료를 선언하지 않는다.
