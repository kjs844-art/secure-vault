# 2026-09-14 — 합성 금고 백업·복원

## 범위와 현재 상태

- 작업: `codex/firstvibe-wanted-ai-championship`, 기준 커밋 `abae281`.
- Spark의 별도 `spark-vault-tools` 작업 폴더 및 `catalogProtocol.ts`,
  `SyntheticVaultSession.ts`는 수정하지 않았습니다.
- 합성 암호문 파일 내보내기와 **빈 저장소에만** 복원을 추가했습니다.
- 실제 비밀번호·API 키·개인 금고 파일은 금지합니다. 공개 고정 데모
  비밀번호이므로 실제 기밀성을 제공하지 않습니다.
- 커밋·push·PR·main 병합·공개 배포·새 서비스 가입은 하지 않았습니다.

## 사용자 흐름

```text
합성 금고 화면 /?view=local-vault
  └─ 백업·복원 연습 /?view=backup (목록 화면을 떠나며 잠김)
       ├─ 합성 테스트 사용 확인
       ├─ 백업 준비 → Worker 인증 → 다운로드 링크 → 사용자가 저장
       └─ 파일 선택 → 복원 클릭 → 512 KiB 상한 확인
            → 빈 저장소 확인 → Worker 전체 인증
            → IndexedDB 원자적 add → 저장된 동일 바이트 재확인
            → 잠긴 상태 유지 → 금고 화면에서 명시적으로 열기
```

브라우저 파일 선택은 서버 업로드가 아닙니다. 이 기능은 `fetch`, 외부 AI,
계정 탐지, 분석 전송을 호출하지 않습니다. 파일명·키 원문·서비스명 목록을
다운로드 파일명이나 백업 화면 상태에 섞지 않습니다.

다운로드는 `keyatlas-synthetic-v1.katldemo`라는 고정 이름과
`application/octet-stream`을 사용합니다. 새 JSON/암호 알고리즘을 만들지
않고 기존 Rust의 `KATLDEMO` v1 바이트를 그대로 운반합니다.

## 코드 위치

| 파일 | 역할 |
| --- | --- |
| `apps/web/src/features/local-vault/SyntheticVaultBackup.ts` | 스냅샷, 검증 순서, 빈 저장소 전용 복원, 취소 세대, 고정 오류 |
| `apps/web/src/features/local-vault/SyntheticBackupFile.ts` | 파일 전체 읽기 전 크기 검사, 읽은 바이트 크기 재검사 |
| `apps/web/src/features/local-vault/SyntheticBackupPanel.tsx` | 확인·선택·명시적 다운로드/복원, 취소·탭 숨김 정리 |
| `apps/web/src/features/local-vault/synthetic-backup.css` | 기존 기능 화면과 일치하는 최소 스타일 |
| `apps/web/src/main.tsx` | 별도 백업 화면 경로 |
| `apps/web/src/features/local-vault/LocalVaultPanel.tsx` | 백업 화면 링크와 현재 기능 설명 |
| `apps/web/src/features/local-vault/SyntheticVaultBackup.test.ts` | 가짜 worker + 격리 fake IndexedDB의 순서·경쟁·취소 69개 사례 |
| `apps/web/src/features/local-vault/SyntheticBackupFile.test.ts` | 읽기 전 크기 제한·고정 오류 14개 사례 |
| `apps/web/src/features/local-vault/SyntheticVaultBackup.wasm.test.ts` | 실제 생성 WASM과 격리 fake IndexedDB의 왕복 7개 사례 |

## Red 관점 — 실패할 때 무엇을 지켜야 하나

| 위험/실수 | 구현 및 검증 | 남아 있는 한계 |
| --- | --- | --- |
| 손상된 파일을 먼저 저장해 금고를 막음 | 기존 Worker 인증이 성공한 뒤에만 `createIfAbsent` 호출 | 파일의 신뢰할 수 있는 출처를 증명하지 않음 |
| 복원으로 기존 금고를 덮어씀 | 기존 값 확인 + 원자적 `add`, 다른 탭이 먼저 생성해도 EXISTS | 교체·병합·버전 업그레이드는 제공하지 않음 |
| 파일 선택 후 원본 바이트 변경 | 첫 await 전 사본, 검증 worker에도 별도 사본 전달 | 악성 same-origin JavaScript 자체를 신뢰 경계 밖으로 격리하지 못함 |
| 취소 뒤 늦은 결과가 다시 표시됨 | 파일 읽기·검증·저장·readback 뒤 세대 검사 | 이미 시작된 암호문 트랜잭션은 완료될 수 있음 |
| 과대 파일·임의 메모장 입력 | 파일 읽기 전 512 KiB 상한, 헤더 식별 후 Rust의 기존 전체 검사 | 공개 데모 형식이라는 사실은 실제 Secret 부재를 증명하지 않음 |
| 오류에 파일명·내용이 노출됨 | 신뢰 경계마다 고정 오류 재생성, UI에도 고정 문구만 표시 | 브라우저/OS 자체 파일 선택·다운로드 기록은 앱에서 지울 수 없음 |
| 남아 있는 다운로드 URL | 취소·새 작업·탭 숨김·언마운트 시 URL 해제 | 이미 시작한 다운로드나 저장된 파일은 취소/삭제하지 않음 |
| 다운로드 클릭을 백업 성공으로 오인 | ‘준비 완료’와 ‘다운로드 요청’을 구분 | 실제 디스크 저장·전원 차단 후 내구성을 보증하지 않음 |
| 유효하지만 오래된 백업 | 형식·암호문 인증 및 동일 바이트 확인만 제공 | rollback 방지·서명된 전체 manifest·기기 인증 미구현 |

### Blue 관점

실패 시 자동 삭제·초기화·덮어쓰기를 하지 않습니다. 복원 후에도 잠긴 상태를
유지하고 사용자가 다시 열어 확인합니다. 기존 Rust 암호화 코어와 저장소
인터페이스는 변경하지 않았습니다. 서비스/Worker를 백업 화면 전용으로
분리하여 Spark의 검색 도구나 금고 세션과 연산 취소를 공유하지 않습니다.

## 검증 증거

작업 폴더 `apps/web`에서 실행했습니다. 단위 테스트용 바이트와 가짜 worker는
암호화 검증 증거가 아닙니다. 실제 WASM 테스트 7개는 암호화를 모킹하지 않습니다.

- `npm test -- --maxWorkers=1 src/features/local-vault/SyntheticBackupFile.test.ts`: 14/14, exit 0.
- `npm test -- --maxWorkers=1 src/features/local-vault/SyntheticVaultBackup.test.ts src/features/local-vault/SyntheticBackupFile.test.ts`: 83/83, exit 0.
- `npm.cmd test -- --maxWorkers=1 src/features/local-vault/SyntheticVaultBackup.wasm.test.ts`: 7/7, exit 0.
- `npm test -- --maxWorkers=1`: 전체 8개 파일, **255/255**, exit 0.
- `npm run build`: TypeScript 검사와 Vite 빌드 exit 0. 공개 배포는 아님.
- 별도 읽기 전용 검토에서 입력 격리·원자적 보존·취소·URL 정리와 오류 재생성을 확인했습니다. 프로덕션 보안 감사는 아닙니다.

초기 검사 중 테스트 fixture 타입과 Vitest 5 API 불일치는 수정했습니다.
일반 권한의 첫 테스트는 `.vite-temp` 쓰기 EPERM으로 시작 전에 차단되었고,
해당 프로젝트 검사에 승인된 실행 권한을 사용한 재검사는 통과했습니다.
Windows 보안 정책을 끄거나 우회하지 않았습니다.

## 미검증 / 이번 범위 밖

- 실제 사용자 키·마스터 비밀번호·생체 인증·계정 복구·신뢰 기기.
- 서버 동기화, Android/iOS 실기기, Safari/Firefox, 클라우드 백업.
- 실제 다운로드 파일의 OS 디스크 내구성과 전원 차단 훈련.
- Rust 전체 workspace 재검사 및 기존 Windows Application Control 4551 차단 항목의 해소.
- 실제 비밀정보 안전성, XSS/공급망/배포 origin에 대한 독립 보안 승인.

## 실제 브라우저 확인

로컬 임시 서버 `127.0.0.1:4179`의 새 origin에서 확인했습니다.
기존 사용자 브라우저 데이터를 삭제하거나 실제 금고를 교체하지 않았습니다.

- 확인 체크 전 백업 준비/파일 선택/복원 버튼 비활성화 확인.
- 빈 저장소에서 백업 준비: ‘저장된 합성 금고가 없습니다’ 안내 확인.
- 실제 브라우저 Worker로 합성 금고 생성 후 3개 항목과 0/1/3개 관계 확인.
- 백업 화면 이동 후 명시적 확인 → 준비 완료 → 다운로드 링크 표시 확인.
- 링크 클릭 후 ‘다운로드 요청’ 안내 확인. 실제 다운로드 파일은
  `C:\Users\USER\Downloads\keyatlas-synthetic-v1.katldemo`, 3892바이트로 확인.
- 위 다운로드 파일을 로컬 Node에서 기존 `openSyntheticArchive`로 직접 인증:
  `downloadedBytes:3892`, `authenticatedRows:3`, `connections:[0,1,3]`, PASS / exit 0.
  다운로드 파일의 실제 암호문 호환성 증거이며 브라우저 복원 UI 테스트는 아닙니다.
- ‘작업 취소 · 준비 파일 비우기’ 후 다운로드 링크 제거 확인.
- 확인 체크만 눌러도 ‘취소됨’이라고 나오던 안내 문구를 수정하고 다시 확인.
- 최종 문구 수정 후 `npm run typecheck`, `npm run build` exit 0.

처음 사용한 agent-browser CLI는 연결 시간 초과가 발생했고 오프라인 진단도
응답하지 않아 중단했습니다. 설치·설정 변경 없이 Codex 브라우저 도구로
전환했습니다. CLI 실패를 제품 실패나 UI 검증 통과로 처리하지 않았습니다.

**별도 브라우저에서 파일 선택 → 복원 버튼 → 다시 열기의 전체 UI 왕복,
실제 탭 숨김 중 파일 읽기/저장 취소는 아직 미검증입니다.** 단위 테스트와
Node의 실제 WASM + fake IndexedDB 검증을 이 증거로 대체해서 표현하지 않습니다.
