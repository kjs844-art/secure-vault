# M01A — 사용자 확인·삭제 제어 검사

2026-09-28 KST. 대상: `codex/firstvibe-mvp-01a-integration-20260927`.
기준 HEAD/origin: `492c63e42d73417f9e524efce462ef5ea3c1496e`, 일치 확인.
시작 시 존재한 외부 환경 보류 안내 3개 문서 수정은 이 체크포인트에 함께 보존한다.
Node 24.19.0/npm 11.17.0. DB·도메인·배포는 사용자 재개 전 보류.

## 변경 파일

- `apps/benefits-web/src/server/review/contracts.ts`: nullable 값, server owner/generation,
  미리보기·검토·삭제 envelope, 트랜잭션 어댑터 계약, 고정 결과 타입.
- `validation.ts`: 정확한 명령/필드, own data property, 한도/날짜/종류/동의 관련 출처 검사,
  기존 메일 후보의 bounded projection와 불변 데이터.
- `review-service.ts`: preview/confirm/reject/remove, owner/ID/revision 확인,
  operation 재사용·충돌, 삭제 표식, 시한과 commit 전후 권한 재확인.
- `tests/review-validation.test.ts`: 값/명령/출처·원래 메일 pipeline 연결 합성 회귀 25개.
- `tests/review-service.test.ts`: 제어/권한/CAS/시한/오류/중복/삭제 합성 회귀 194개.
- `tests/support/review-memory-store.ts`: 테스트 전용 serialized snapshot/rollback 모델.
- `scripts/check-boundaries.mjs`: 새 서버 전용 marker의 client bundle 혼입 검사.
- README/MAIL_CONTRACT/REVIEW_CONTRACT 및 M01A/START_HERE/TWO_WEEK_PLAN/SESSION_HANDOFF, 이 기록.

새 DB 파일/서비스/클라우드 계정/네트워크 어댑터/실제 메일·키는 만들거나 사용하지 않았다.
원본 benefit-validator/Lovable/DB, 금고 코드, M02 예약 UI, 다른 worktree는 변경하지 않았다.

## 구현의 의미

미리 본 값은 preview ID에 고정되고 편집하려면 새 preview가 필요하다.
확인은 후보·서비스의 owner와 현재 revision이 일치할 때만 진행한다.
같은 operation의 다른 body는 충돌, 같은 body는 현재 결과를 다시 읽는다.
삭제 후에는 deleted/null만 반환하며 과거 성공 payload로 레코드를 재생성하지 않는다.

검토 상태는 accepted-by-user이지만 account/current-balance proof는 not-established다.
관찰일 null을 검토 시각으로 채우지 않고, 수정값의 출처 및 PARTIAL_MAIL_TEXT 등의 경고를 유지한다.
[상세 계약과 한계](../../../apps/benefits-web/REVIEW_CONTRACT.md)에 어댑터 의무와 UI 후속 규칙이 있다.
agent-consent-patterns의 action preview/명시적 결정/좁은 소유권/정직한 처리 기록을 반영했다.

## 검사

앱 명령은 `apps/benefits-web`에서 실행했다. 현재 새 코드의 로컬 검증이다.

| 명령 | 확인 결과 |
|---|---|
| `node --import tsx --test tests/review-service.test.ts` | 194/194, exit 0 |
| `node --import tsx --test tests/review-validation.test.ts` | 25/25, exit 0 |
| `npm test` | 540/540, fail/cancel/skip 0, exit 0 |
| `npm run build` | client/SSR/Nitro/TypeScript exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run check:boundaries` | source 17/client 4, exit 0 |
| `npm run test:smoke` | loopback SSR/assets 4, CLOSED, exit 0 |
| `check-markdown-links.ps1 -Root <각 변경 Markdown>` | 8개 문서의 로컬 상대 링크, 각 exit 0 |
| `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1` | SECRET_SCAN_PASSED, baseline 4, CLOSED, exit 0 |
| `git diff --check` | exit 0 |

형식/입력 검사 테스트는 실제 인증이나 사람이 화면을 읽었다는 증거가 아니다.
메모리 모델의 원자성은 실제 DB 격리·병렬 서버·RLS·내구성 증거가 아니다.
HTTP smoke는 hydration·모바일 화면·실메일 E2E 검사가 아니다.
이번 변경은 vault/Rust source를 수정하지 않으며 로컬 전체 Rust 회귀는 새로 실행하지 않았다.

## 독립 검토에서 보강한 점

1. 미리보기 TTL도 transaction commit 조건에 등록한다. callback 종료와 commit 사이 지연은
   실제 어댑터가 `limitCommitTime` 조건을 강제해야 한다.
2. transaction 완료를 기다리는 동안 로그아웃/세션 변경이 생기면 최종 guard가 payload를 차단한다.
   독립 메모리 진단: confirm commit 직후 sessionRevision 변경 → AUTHORITY_CHANGED,
   payload 없음, benefit 1/operation 1 유지, rollback 0. 진단 exit 0.
   이미 commit된 데이터가 있으므로 실패를 rollback 성공이라고 하지 않는다.
3. pending preview revision 1/내용 불변과 후보 재사용 금지. 안전 정수 revision 증가 상한 검사.
4. 저장소가 JSON 객체 키 순서를 바꿔도 정상 valueOrigins를 거부하지 않도록 key-wise 검사한다.
5. 부분 메일·날짜 미상 등의 reviewReasons가 후보 projection 중 사라지지 않도록 보존한다.

메모리 helper의 상태전이/불변성/삭제 revision overflow도 보강했다.
최종 독립 검토에서 추가 확정 차단 결함을 발견하지 못했지만 전체 보안 감사를 의미하지 않는다.

## Git/CI 구분과 이후 작업

기준 SHA의 원격 실행:
- [run 36359307747](https://github.com/kjs844-art/secure-vault/actions/runs/36359307747)
- [run 36359305334](https://github.com/kjs844-art/secure-vault/actions/runs/36359305334)

2026-09-28 09:13 KST 조회에서 둘 다 실제 in_progress/Rust workspace verifier 단계였다.
기준 SHA의 scan/두 PowerShell 스캐너 회귀/실제 pinned Pester 정책 검사 통과를 확인했다.
이 상태는 현재 로컬 확인 제어 코드의 원격 CI 통과가 아니다.
진행 중 실행을 취소하지 않도록 우선 로컬 commit으로 보관하고, push 전 같은 run과 원격 SHA를 재조회한다.
09:19 KST 재조회에서 두 실행 모두 Rust 전체 검증과 두 WASM 생성·smoke를 통과했고
각각 benefits 앱 검사 / 기존 web 앱 검사 중이었다. 원격 HEAD는 여전히 기준 SHA였다.
이는 관찰 시점 기록이며 최종 원격 통과 또는 새 코드의 push 완료를 뜻하지 않는다.

09:21 KST 최종 조회: 위 두 run 모두 `completed/success`, head SHA는 `492c63e`였다.
이번 구현은 로컬 `94d29d55c41d1e7f5ec96ca0e8c806a3e4742e4f`에 commit했고 작업트리는 clean이었다.
이후 같은 기능 브랜치에 비강제 push할 수 있는 체크포인트다. 기준 SHA의 CI 성공을
새 구현 SHA의 CI 성공으로 대체하지 않으며, 새 원격 검사는 별도 확인해야 한다.

남은 코드/검증은 후보 생성·조회/보관/계정 삭제 정책, 재분석 stable source 연결,
기존 UI domain으로의 안전한 투영, 지연 응답 UI generation/revision fence,
실제 auth/DB/provider 어댑터와 요청 보안·E2E, B05 실제 파일 새 프로필 복원 등이다.
클라우드 DB/도메인/배포 설정은 사용자 재개 전 금지이며 원본 DB를 대체 수단으로 연결하지 않는다.

`REAL_SECRET_GATE=CLOSED`. 실제 금고 Secret/운영 배포 또는 M01A 전체 완료를 선언하지 않는다.
