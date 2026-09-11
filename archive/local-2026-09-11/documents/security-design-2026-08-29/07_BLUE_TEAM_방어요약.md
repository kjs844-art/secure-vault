# KeyAtlas BLUE Team 방어 요약

이 문서는 RED 중심 기록을 실제 예방·탐지·복구 행동으로 바꾸기 위한 짧은 체크리스트다.

## 예방

- [ ] Windows custom VFS에서 actual main/WAL/SHM I/O 결속
- [ ] 미지원 상태는 약한 fallback 없이 fail-closed
- [ ] `unsafe`를 작은 native crate에만 격리
- [ ] private snapshot 완료 전 검증 타입 승격 금지
- [ ] wrong password 전에 RW open 금지
- [ ] future/corrupt 자동 수정·migration 금지
- [ ] RO file-set epoch를 RW store lifetime까지 유지
- [ ] raw connection/handle/Secret type 외부 노출 금지

## 탐지

- [ ] identity/role/size/share-policy mismatch 사건만 기록
- [ ] 로그에는 Secret, ciphertext, 전체 경로, 사용자 이름 금지
- [ ] VFS read/write/truncate/SHM policy 위반 count
- [ ] snapshot create/cancel/discard/promote 상태
- [ ] RO→RW epoch/digest mismatch
- [ ] rollback/omission checkpoint mismatch

## 복구

- [ ] 원본 main/WAL/SHM 보존 후 진단
- [ ] 부분 snapshot 폐기, 원본 자동 수정 금지
- [ ] backup/export는 main-only copy 금지
- [ ] synthetic data로 restore drill
- [ ] recovery factor 변경 시 지연·알림·재인증
- [ ] 분실 기기 capability 폐기와 key rotation

## 출시 gate

- [ ] VFS/actual-handle 설계와 구현 독립 검토
- [ ] main/WAL/SHM race matrix 통과
- [ ] wrong-password 원본 무쓰기 통과
- [ ] future/corrupt byte preservation 통과
- [ ] crash-WAL correctness 통과
- [ ] rollback/omission anchor 통과
- [ ] recovery/device-key 훈련 통과
- [ ] workspace format/Clippy/test/secret scan 통과
- [ ] 미해결 Critical/Important 0개

모두 끝나기 전에는 실제 비밀번호/API 키/Secret 입력을 열지 않는다.

## 2026-08-31 Windows 개발 호스트 방어

- [x] Code Integrity `3033/3077/3089`로 `4551` 차단 계층과 exact EXE 식별
- [x] 이벤트 SHA-256 Flat Hash와 실제 EXE hash 일치 확인
- [x] Smart App Control `VerifiedAndReputableDesktop` enforcement 유지
- [x] registry/`.cip`/Secure Boot/Defender 설정 무변경
- [ ] 신뢰된 RSA 서명 또는 전용 검증 환경 중 하나를 별도 승인·설계
- [ ] hosted CI를 쓰더라도 `contents: read`, 수동 실행, immutable action SHA 적용
- [ ] ordinary suite 실행 시 새 `3033/3077`과 integer exit code를 함께 기록
- [ ] 다른 호스트의 성공을 현재 pinned-host Pass로 승격하지 않기

BLUE 관점의 기본값은 “테스트를 위해 일상용 PC의 보안 경계를 약화하지 않는다”다.

## 2026-09-07 검증 운영 보강

- [x] 기본 구성과 feature 일반 구성을 분리해 검사하는 실행 스크립트 추가
- [x] 첫 실패 즉시 중단, 종료 코드 보존, 성공 요약 오출력 방지
- [x] 전체 기본 Rust 테스트 및 Clippy·포맷·문서 예제 실제 실행 통과
- [x] 스크립트 자체 회귀 검사 11개를 PowerShell 5.1/7에서 각각 통과
- [x] 현재 이동 경로, 기존 작업 보존, 미확인 사항을 RED 기록과 분리해 문서화
- [x] OS 보안 정책, main, 실제 Secret 입력, 공개 배포 무변경
- [ ] 별도 Phase 0A 권위 판정과 full VFS/store 경계 승인
- [ ] 복구·기기 키·동기화·실제 Secret 출시 게이트

일반 검사 통과는 위 미완료 항목을 대신하지 않는다. [이번 작업 요약](13_2026-09-07_작업결과.md)에 코드 위치와 최종 상태를 기록한다.
