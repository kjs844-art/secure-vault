# M01A — Gmail 실행 제어와 benefits-web CI 연결

실행: 2026-09-28 KST, Windows / Node 24.19.0 / npm 11.17.0.
대상 branch: `codex/firstvibe-mvp-01a-integration-20260927`.
변경 전 local/origin HEAD: `b7e4c0e655c2188c8af7a65ac3a57a27e5d502b8`, clean 확인.
이 문서가 포함된 후속 커밋이 이번 체크포인트다. 원본 benefit-validator/Lovable/DB는 변경하지 않았다.

## 구현 범위

- `apps/benefits-web/src/server/mail/run-analysis.ts`: provider 독립 서버 내부 실행 제어.
  검증된 principal과 독립 메일/외부 분석 동의를 요구하는 어댑터 계약, 사용자·세션·메일
  연결·수신자·정책·일회 operation 결합, 엄격한 quota 응답, 단계별 권한 재확인.
- 명시적 snapshot/freeze, 고정 제한의 메일 정규화/후보 검증, 일반화된 오류.
- 전체 실행/권한 만료 deadline, AbortSignal, 늦은 결과 폐기, 재시도·환불 없음.
- 원문/토큰/예외를 담지 않는 비영속 처리 관찰 receipt. 전송 회수나 DB 저장 증거가 아니다.
- `tests/run-analysis.test.ts`: 새 합성 테스트 192개. 실제 네트워크/제공자/DB는 사용하지 않았다.
- `scripts/check-boundaries.mjs`: 새 서버 내부 marker의 client bundle 혼입 검사.
- `.github/workflows/security-gates.yml`: 기존 gates를 유지하고 benefits-web 설치 → 테스트 →
  빌드 → typecheck → bundle boundary → loopback SSR smoke → 최종 Secret 재검사 연결.
- `tests/verification/verify-security-workflow.Tests.ps1`: 단계 누락/중복/명령·cwd·shell 변경,
  조건부 skip/실패 무시/순서 변경/최종 검사 이동의 정책 회귀 추가.
- 앱 README/MAIL_CONTRACT/MAIL_RUN_CONTRACT, M01A/SESSION_HANDOFF와 이 검사 기록.

공개 라우트·실제 auth/consent/quota 저장소·메일/AI 호출을 연결하지 않았다.
[실행 계약](../../../apps/benefits-web/MAIL_RUN_CONTRACT.md)에 각 어댑터의 실제 구현 의무와
한계가 있다. agent-consent-patterns의 독립 동의·좁은 권한·정직한 취소/처리 기록 원칙을 반영했다.

## 로컬 검사와 정확한 한계

앱 명령은 `apps/benefits-web`, Git/PowerShell 명령은 대상 repo root에서 실행했다.

| 명령 또는 검사 | 결과 |
|---|---|
| `node --import tsx --test tests/run-analysis.test.ts` | 192/192, exit 0 (테스트 담당자 실행) |
| `npm test` | 321/321, fail/cancel/skip 0, exit 0 (주 담당 재실행 포함) |
| `npm run build` | client/SSR/Nitro/TypeScript exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run check:boundaries` | source 14/client 4, exit 0 |
| `npm run test:smoke` | loopback SSR/assets 4, CLOSED, exit 0 |
| PowerShell AST 문법 및 정책 본문 직접 검사 | PS7.6.5 / PS5.1.26100.9444 각각 16/16, exit 0 |
| 변경 Markdown 상대 링크 검사 | 6개 파일 통과, exit 0 |
| `git diff --check` | exit 0 |
| `pwsh -NoProfile -NonInteractive -File .\scripts\check-repository-secrets.ps1 -Root $PWD.Path` | baseline 4 / SECRET_SCAN_PASSED / REAL_SECRET_GATE=CLOSED, exit 0 |

정책 검사는 AST에서 BeforeAll/It 본문을 추출해 메모리에서 직접 실행한 것이다.
로컬에 Pester 3.4.0만 발견했으며 새 모듈을 설치하지 않았다. **Pester 5.7.1 통과로 표기하지 않는다.**
실제 CI의 pinned Pester 실행은 새 커밋의 원격 결과로 별도 확인해야 한다.
정책 regex 검사는 이 workflow의 목표한 구조에 대한 회귀이지 범용 YAML 보안 분석기가 아니다.

HTTP smoke는 browser hydration/모바일 화면/실메일 E2E가 아니다.
새 화면/시각 디자인 변경이 없어 이번 작업에서 브라우저 UI 검사를 반복하지 않았다.
25–45ms 타이머/지연 회귀는 과부하 환경에서 시간 민감성이 있다. 간헐 실패 시 검증을
삭제하거나 통과로 처리하지 말고 clock 주입 등 결정적 검사로 개선한다.

## 독립 검토와 수정

처음 구현은 알려진 동의 만료를 타이머로만 처리했다. microtask/동기 처리로 타이머가
밀리면 이미 만료된 상태에서 다음 메일 어댑터를 먼저 호출할 수 있었다.
실행 제한과 별도로 `authorityDeadline`을 유지하고 다음 호출 직전/최종 반환 전에 직접 비교하도록 수정했다.

동일한 합성 메모리 진단을 독립 검토자가 재실행했다(exit 0, 네트워크/실제 대상 없음).

| 관찰 | 수정 전 | 수정 후 |
|---|---:|---:|
| 만료 뒤 mailbox 호출 | 1회 | 0회 |
| 실패 코드 | AUTHORITY_CHANGED | AUTHORITY_CHANGED |
| mailbox receipt | returned | not-started |

테스트는 오류 코드만 검사하지 않고 mailbox/analyzer 호출 횟수와 not-started 상태까지
검사한다. 최종 timestamp 계산이 만료 타이머를 지연하는 경우도 성공을 반환하지 않는다.
최종 읽기 검토에서 추가 차단 문제는 발견하지 못했다. 전체 보안 감사 완료를 뜻하지 않는다.

## 원격 CI 관찰

기준 SHA의 [run 36357247415](https://github.com/kjs844-art/secure-vault/actions/runs/36357247415)는
2026-09-28 08:31 KST 조회 시 Secret scan, PS7/PS5.1 스캐너 회귀, 기존 정책 검사,
Rust 도구 설치/의존성/wasm-bindgen CLI를 통과하고 Rust workspace verifier 진행 중이었다.
이전 인코딩 fixture 문제의 PS5.1 단계 통과는 확인했지만 당시 전체 run은 완료되지 않았다.
이 기준 run에는 이번 benefits-web CI 변경이 없다. 후속 SHA의 원격 결과와 혼동하지 않는다.

## 미검증 / 남은 작업

- 실제 인증 principal/독립 동의 UI와 저장, OAuth 연결 소유권, 영속 quota/동시성.
- provider payload projection, stream 응답 제한, 실제 중단/철회, 원격 dispatch 경쟁 조건.
- 사용자 확인 전환, DB 소유권/RLS, 원자적 확인 저장, 재분석/idempotency, 삭제/retention.
- 실제 Gmail 형식·AI 제공자 호환성, 모델 결과의 의미상 정확성/개인정보 제거.
- 새 커밋의 원격 전체 CI/Pester 5 실행, vault 전체 회귀/B05 새 프로필 복원.
- 도메인, 새 개발 계정/DB, 최종 디자인, 공개 배포와 main 병합.

`REAL_SECRET_GATE=CLOSED`. 합성 ledger의 성공은 실제 DB 원자성 증거가 아니다.
원본 앱·DB는 동결하며 이번 작업으로 M01A 전체 또는 2주 출시 목표 완료를 선언하지 않는다.
