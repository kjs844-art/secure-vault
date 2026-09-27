# 2026-09-15 합성 웹 금고 등록을 위한 암호문 CAS

기능 브랜치: `codex/firstvibe-local-session-hardening`. 기존 `bc860a2` 백업 이후 작업.
사용자가 승인한 합성 수동 등록을 준비하는 저장소 기능이며, 등록 UI 완료 기록은 아니다.

## 저장 계약

`apps/web/src/storage/SyntheticCiphertextStore.ts`의 기존 read/createIfAbsent 인터페이스는
유지하고, `SyntheticMutableCiphertextStore`를 확장 인터페이스로 추가했다.
factory가 반환하는 새 기능은 `compareAndSwapArchive(expected, next)`다.

```text
expected/next 검증·복사 → DB 열기 → 하나의 readwrite transaction
  ├─ archive 없음 → missing (새 값 생성하지 않음)
  ├─ 현재 bytes != expected → conflict (쓰기 없음)
  └─ 현재 bytes == expected → put(next) → transaction complete → updated

스키마/손상/쓰기 오류/abort → 고정 오류 → 기존 저장 내용 보존
```

길이만 비교하거나 read 뒤 별도 transaction으로 무조건 쓰지 않는다.
입력 두 개를 DB open 이전에 복사하고 실제 TypedArray 길이로 1–524288 bytes 제한을 적용한다.
request success는 커밋 증거가 아니므로 transaction 완료 전에는 updated를 반환하지 않는다.
기존 createIfAbsent는 계속 add를 사용하고 기존 값은 덮어쓰지 않는다.

## RED 검토

- 동시 수정/오래된 입력: 두 저장소 인스턴스의 경쟁에서 한 쪽만 updated, 다른 쪽은 conflict.
- 같은 길이의 다른 암호문: 바이트 전체 비교로 거부하며 현재 값을 유지.
- 입력 변경: DB를 여는 동안 호출자가 입력을 바꿔도 동기 snapshot 유지.
- 길이 검사 우회: 변경 가능한 인스턴스 속성이 아닌 네이티브 TypedArray getter로 실제 길이 검사.
  빈/초과 입력은 CAS 양쪽 및 create 모두 DB open 이전에 거부.
- 요청 성공 뒤 abort/쓰기 오류: 롤백 뒤 이전 bytes 보존, 성공으로 표시하지 않음.
- 알 수 없는 스키마/추가 키/손상된 값: 자동 초기화/복구/삭제하지 않음.
- 동기 get/put 오류와 오류 객체 검사 예외: 입력/오류 원문을 로그로 내보내지 않는 고정 오류 처리.

독립 정적 검토에서 초기 길이 검사 문제를 확인했고 수정 후 재검토에서 이 범위의
구체적인 차단 결함을 추가로 찾지 않았다. 실제 브라우저 내구성이나 전체 암호 보안 감사는 아니다.

## 검사 결과

작업 디렉터리 `apps/web`.

| 검사 | 결과 |
|---|---|
| 최초 CAS 테스트 | 메서드 없음: 1 FAIL / 35 PASS (exit 1) |
| 길이 검사 회귀 추가 직후 | 6 FAIL / 77 PASS (exit 1) |
| `npm test -- src/storage/SyntheticCiphertextStore.test.ts --maxWorkers=1` | 최종 83/83, exit 0 |
| 중간 전체 타입 검사 | test의 unchecked 배열 접근 2곳에서 실패, 이후 수정 |
| 최종 `npm.cmd run typecheck --prefix apps/web` (repo root) | exit 0 |
| 최종 `npm.cmd test --prefix apps/web -- --maxWorkers=1` | 13개 파일, 523/523, exit 0 |
| 최종 `npm.cmd run build --prefix apps/web` | exit 0 |

저장소 테스트는 fake-indexeddb를 사용한다. 실제 Comet 검사는 새 도구 화면의 생성/검색/잠금
경로를 확인한 것이지 CAS 경쟁 호출이나 강제 종료 내구성을 검증한 것이 아니다.

## 아직 구현하지 않은 것

이 저장소는 불투명한 bytes만 다룬다. 암호문 인증, archive 내부 버전, 합성 출처 증명,
유효한 과거 bytes로 되돌림, record별 이력/충돌 복구함/동기화는 검증하지 않는다.
future **DB 스키마** 보존 테스트를 future **암호문 형식** 인증 테스트로 표현하지 않는다.

등록에는 닫힌 Rust fixture 선택 API, 기존 모든 record 인증 후 신규 envelope 추가,
v1 읽기를 유지하는 가변 개수 archive v2, v2 백업/복원, Worker 후보 생성, CAS 후 저장본
readback·재인증, 합성 선택형 UI가 이어져야 한다. 이 저장 API만으로 등록 성공을 표시하지 않는다.

`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`. 실제 Secret·운영 계정·배포는 열지 않았다.
