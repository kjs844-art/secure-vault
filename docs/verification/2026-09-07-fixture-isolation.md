# 2026-09-07 내부 자동검사 대역 격리 보강

## 범위와 완료 기준

사용자가 화면·로그인·결제 작업을 미루고, 계정이나 실제 키 없이 가능한 내부 보강을 요청했다. 기존 검증 도구를 재사용한다. 이번 범위는 제품 기능 추가나 보안 출시 승인이 아닌 테스트 실행 안전장치다.

- 정상 대역을 사용하면 기존 회귀 검사 11개가 통과해야 한다.
- 대역이 누락되면 설치된 Cargo로 넘어가기 전에 종료 코드 1로 중단해야 한다.
- 정상 실행과 실행 중 실패 모두 `PHASE_0A_VERDICT=UNCHANGED`, `REAL_SECRET_GATE=CLOSED`를 각각 정확히 한 번 확인한다.
- 금고 원문, 암호화 방식, DB 형식, 로그인·결제·외부 계정은 변경하지 않는다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| [verify-local.Tests.ps1](../../tests/verification/verify-local.Tests.ps1) | 대역 존재 확인, PATH를 대역 디렉터리로 제한, 실제 명령 해석 경로 확인, 두 보안 상태 marker 검사 보강 |
| [verify-fixture-isolation.Tests.ps1](../../tests/verification/verify-fixture-isolation.Tests.ps1) | 소유한 임시 복사본에서 대역 누락/정상 사례 검사, 환경변수 복원 및 검증된 임시 폴더 정리 |
| [fallback/cargo.cmd](../../tests/verification/fixtures/fallback/cargo.cmd) | 실제 Cargo 대신 고정 marker를 출력/기록한 뒤 종료 코드 97만 반환하는 대역 |
| [README.md](../../README.md) | 새 검사 실행 방법과 검증 한계 안내 |
| 이 문서 | 실패→수정→통과 증거와 RED/BLUE 관점 기록 |

기존 `scripts/verify-local.ps1` 및 Rust 제품 소스는 이번에 수정하지 않았다. 작업 시작 전 미커밋 변경은 보존했으며 커밋·푸시·PR 변경·배포를 하지 않았다.

## RED 중심: 어떤 실패를 막았나

기존 회귀 테스트는 대역 폴더를 원래 PATH 앞에 붙였다. 대역 파일이 빠지면 원래 PATH에 설치된 Cargo를 대신 실행할 수 있었다. 이는 조건부 테스트 격리 결함이며 사용자 금고 침해를 재현한 결과가 아니다.

새 검사는 실제 Cargo를 경로에서 제외하고 고정 marker만 남기는 대역을 배치한다. 자식 테스트가 출력을 내부에서 캡처할 수 있으므로 화면 문구뿐 아니라 임시 marker 파일 생성 여부를 검사한다. 외부 시스템이나 실제 비밀정보를 사용하지 않는다.

| 위험/회귀 | 적용한 확인 |
|---|---|
| 대역 누락 후 다른 Cargo 실행 | 파일 존재를 먼저 확인. PATH를 대역만으로 제한하고 Get-Command 결과도 예상 파일과 일치하는지 확인 |
| 화면 출력에 marker가 없다는 이유로 미실행 오판 | 소유 sandbox 안의 marker 파일이 생성됐는지 별도 확인 |
| 일반 테스트 통과를 실제 키 사용 승인으로 오인 | 정상 및 단계별 실행 실패에서 두 상태 marker의 값과 개수를 확인 |
| 임시 테스트가 원본 프로젝트를 변경 | 필요한 소스만 GUID 임시 폴더로 복사하고 그 안에서 실행 |
| 잘못된 폴더 정리 | 절대경로 일치·임시 폴더 내부·루트 reparse 여부를 확인한 뒤 소유 폴더만 정리 |

보안 상태 marker 검사는 성공 두 모드, 단계별 실패, Cargo 누락에 적용한다. 스크립트 본문 실행 전의 잘못된 인자 거부는 기존처럼 비정상 종료와 Cargo 미실행 여부로 검사한다.

## 관찰한 실행 결과

1. 수정 전 기존 회귀 검사: PowerShell 7에서 11개 통과, `VERIFIER_BASELINE_EXIT=0`.
2. 새 격리 테스트의 첫 시도는 PATHEXT를 `.CMD`만으로 제한해 PowerShell 자식 실행이 정상 종료 코드를 제공하지 못했다. 이 실패를 제품 결함의 RED 증거로 계산하지 않았다. `.EXE;.CMD`로 고치되 PATH는 여전히 테스트 대역 디렉터리만 허용했다.
3. 의도한 RED: 대역 누락 사례에서 fallback marker 파일 생성과 명확한 fixture 오류 부재를 확인, `FIXTURE_ISOLATION_RED_EXIT=1`.
4. 격리 방어 구현 후 GREEN: PowerShell 7에서 누락 사례와 정상 복사본 사례 모두 통과, `FIXTURE_ISOLATION_TESTS_PASSED=2`, `FIXTURE_ISOLATION_GREEN_EXIT=0`. 정상 복사본 내부의 기존 11개 회귀 검사 통과도 assertion으로 확인했다.
5. PowerShell 5.1 시도는 호스트 실행 정책에 의해 스크립트 로딩 단계에서 거부됐다. `FIXTURE_ISOLATION_PS51_EXIT=1`이며 이 환경에서 새 테스트가 통과했다고 주장하지 않는다. 실행 정책 변경·우회는 하지 않았다.

작업 중 로컬 도구가 한동안 응답하지 않아 저장 여부를 확인하지 못했지만, 응답 복구 후 실제 세 파일을 읽고 문법 검사 종료 코드 0을 확인한 다음 위 실행을 진행했다. 도구 지연의 원인은 조사하지 않았다.

## BLUE 요약 및 남은 경계

- 실행 환경과 대역을 명시적으로 격리하고, 오류·보안 판정을 숨기지 않도록 회귀 검사를 강화했다.
- 다른 에이전트가 대역 격리, 환경 복원, 임시 폴더 정리와 marker 검사를 읽기 전용으로 검토했다. 추가로 수정할 중요한 문제는 보고되지 않았다. 독립 제품 보안 감사 완료를 뜻하지 않는다.
- 이번 결과는 PowerShell 테스트 도구 검증이다. 실제 Rust 전체 테스트·Clippy·암호화 안전성·Windows Phase 0A gate·웹/앱/서버·실제 Secret·결제·배포를 새로 검증한 것이 아니다.
- 임의의 로컬 악성 파일 변경이나 파일 교체 경쟁까지 방어하는 보안 sandbox를 구현한 것은 아니다. 대역 누락에 대한 테스트 격리 경계를 보강했다.
- `PHASE_0A_VERDICT=UNCHANGED`, `REAL_SECRET_GATE=CLOSED`를 유지한다.

## 다시 실행

허용된 PowerShell 7 환경에서 저장소 루트 기준:

```powershell
pwsh -NoProfile -NonInteractive -File .\tests\verification\verify-local.Tests.ps1
pwsh -NoProfile -NonInteractive -File .\tests\verification\verify-fixture-isolation.Tests.ps1
```

호스트 정책이 실행을 차단하면 우회하지 말고 정책/관리자 승인 여부를 별도로 확인한다. 이전 Rust 검증 결과는 [앞선 실행 기록](2026-09-07-local-verification-maintenance.md)과 구분해서 읽는다.
