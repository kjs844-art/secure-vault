# M01A — Gmail 순수 처리와 CI fixture 수리

실행: 2026-09-28 KST, Windows / Node 24.19.0 / npm 11.17.0.
대상: `codex/firstvibe-mvp-01a-integration-20260927`.
변경 전 local/origin HEAD: `e28ee252dba8f0c6e42de9db0e4616b2f9699ad4`, clean 확인.
이 문서가 포함된 후속 커밋이 이번 체크포인트다.
원본 검토 SHA: `954da8da0b12d55a342d187fab17abe57b93fbb0`, 읽기 전용.

## 변경 파일과 동작

- `apps/benefits-web/src/server/mail/contracts.ts`: 한도/경고/임시 근거/미확인 후보 타입.
- `normalize-gmail.ts`: FULL JSON 크기와 MIME 구조 제한, base64url/UTF-8 검사,
  첨부/HTML 제외, 제한된 plain/snippet, 알 수 없는 수신일 null, frozen 결과.
- `validate-candidates.ts`: 버전/필드/유한 숫자/날짜/근거 span 검사,
  지급/잔량 분리, 전체 배치 실패 정책, pending-review/unverified만 반환.
- `tests/{normalize-gmail,mail-candidates,mail-pipeline}.test.ts`: 새 합성 검사 80개.
- `scripts/check-boundaries.mjs`: 새 서버 전용 marker의 client bundle 혼입 검사 추가.
- 앱 README/PROVENANCE/MAIL_CONTRACT와 M01A/INTEGRATION_BOUNDARY/SESSION_HANDOFF 갱신.
- `tests/verification/check-repository-secrets.Tests.ps1`: Unicode fixture UTF-8 저장
  및 코드 포인트 보존 assertion 한 곳. 스캐너/regex/workflow는 변경하지 않았다.

메일/AI 입력은 합성 fixture뿐이다. 실제 메일·계정·API 키·원본 DB에 접근하지 않았다.
실제 route로 연결하지 않았고 unconnected/CLOSED 상태를 유지한다.
이 작업의 [상세 입출력 계약](../../../apps/benefits-web/MAIL_CONTRACT.md)을 참조한다.

## 원격 CI 실패의 증거와 수리

[원래 실패 작업](https://github.com/kjs844-art/secure-vault/actions/runs/36329827785/job/108649511809)은
e28ee252...에서 전체 Secret scan과 PS7 regression을 통과한 뒤 PS5.1에서 실패했다.
고정 오류는 `The prefilter must not expand this engine's invariant Unicode regex language.`이다.
뒤의 Rust/WASM/web 검사는 skipped였으므로 통과로 보지 않는다.

해당 fixture를 Set-Content로 저장할 때 인코딩이 지정되지 않아 PS5.1 ANSI 변환 중
코드 포인트가 바뀔 수 있었다. 기대값은 변환 전 .NET 문자열에서 계산했다.
독립 메모리 검사에서 CP1252는 U+212A를 ASCII K로 바꿔 regex 결과가 달라졌고,
로컬 CP949는 '?'로 바꾸어 우연히 같은 판정을 유지했다. CI runner의 실제 code page는
기록에 없으므로 CP1252 환경 가설과 확인된 인코딩 결함을 구분한다.

UTF-8 no BOM 쓰기와 재읽기 exact equality 검사만 추가했다.
스캐너를 완화하거나 실패 검사를 건너뛰지 않았다. 수정 후 원격 CI 성공은
새 push의 해당 SHA 실행을 별도로 확인해야 한다.

## 로컬 검사

앱 명령은 `apps/benefits-web`, PowerShell/Git 명령은 대상 repo root에서 실행했다.

| 명령 | 결과 |
|---|---|
| `npm test` | 129/129 PASS, fail/skip 0, exit 0 (기존 49 + 새 80) |
| `npm run build` | client/SSR/Nitro/TypeScript exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run check:boundaries` | source 13/client 4, exit 0 |
| `npm run test:smoke` | loopback SSR/assets 4/미연결 경로/자기 child 정리, exit 0 |
| `pwsh -NoProfile -NonInteractive -File .\tests\verification\check-repository-secrets.Tests.ps1` | 102 PASS / 0 FAIL, exit 0 |
| `powershell.exe -NoProfile -NonInteractive -File .\tests\verification\check-repository-secrets.Tests.ps1` | 102 PASS / 0 FAIL, exit 0 |
| `pwsh -NoProfile -NonInteractive -File .\scripts\check-repository-secrets.ps1` | baseline 4 / SECRET_SCAN_PASSED / CLOSED, exit 0 |
| 문서 상대 링크 검사 / `git diff --check` | 변경 Markdown 7개 통과 / diff check exit 0 |

앱 연속 검사의 최종 `MAIL_PIPELINE_APP_CHECKS_PASSED`와 exit 0를 확인했다.
위 문서 링크 검사는 umbrella의 `scripts/check-markdown-links.ps1 -Root <변경 MD>`를
각 파일에 실행했다. commit 직전 staged diff와 Secret scan도 다시 확인한다.
새 시각 디자인/화면 변경이 없어 이번 묶음에서 브라우저 수동 UI 검사는 반복하지 않았다.
HTTP smoke는 브라우저 hydration/모바일 또는 실메일 E2E 증거가 아니다.

## 독립 검토와 반영

- 원본 source 감사: AI 후보 즉시 upsert, 현재시각 fallback, 파싱 제한 부족을 확인하고
  새 순수 계약에서 자동 저장/날짜 발명을 제거했다. 실 DB 결함 재현은 하지 않았다.
- 후보 검토: 34/34 + 독립 경계 검사 exit 0. 현재 내부 normalizer 전제에서 새 must-fix 없음.
  별도 probe는 100/101 후보, 256KiB 경계, UTF-16 이모지 span, 세기 윤년을 확인했다.
- 파서 검토: RFC2231 이어지는 filename 표시도 첨부로 제외하도록 보완했다.
- 공식 FULL representation 검토 후, 원본 MIME transfer header 때문에 정상 body를
  거절하거나 이중 해독하지 않도록 수정했다. 정확한 padding 포함/생략 모두 시험했다.
- claim quote 연결은 의미상 사실 검증이 아니다. AI confidence가 높아도 확인 전 후보다.
  이름 필드에 개인정보가 섞이지 않는다는 보장도 없으며 문서/테스트에 이를 명시했다.

## 미완료 / 다음 단계

- 인증 principal, 메일/외부 분석 별도 동의, quota, 취소/철회, 안전한 provider 오류 adapter.
- 사용자 확인 전환, 동일 사용자 서비스 소유권, 영속 idempotency/revision, 삭제와 retention.
- 실제 Google OAuth/Gmail/외부 AI/새 DB/RLS 검증과 실제 UI 연결.
- 다양한 실제 Gmail 형식/UTF-8 외 charset, 전체 MIME/RFC2047 및 제공자 호환성.
- 새 앱 CI wiring, 수정 후 원격 전체 CI, vault 전체 회귀/B05 실파일 새 프로필 복원.
- 도메인/클라우드 계정/최종 디자인/배포/main merge. 원본 Lovable repo/DB는 동결 유지.

`REAL_SECRET_GATE=CLOSED`. 이번 체크포인트로 전체 M01A나 서비스 출시가 완료되지 않는다.
