# Windows Smart App Control 4551 원인 분석 요약

작성일: 2026-08-31

권위 원문:
`C:\Users\USER\Desktop\secure-vault-sqlite-store-design\docs\verification\windows-smart-app-control-4551-root-cause.md`

## 결론

`cargo test`가 만든 Rust 테스트 EXE 자체의 코드 오류가 확인된 것이 아니다.
Windows Smart App Control의 강제 정책 `VerifiedAndReputableDesktop`가 디지털
서명이 없는 새 테스트 EXE를 SAC가 요구한 App Control signing level `2`
미충족으로 차단했다.

## 직접 증거

- Code Integrity 이벤트: `3033`, `3077`
- 정책 GUID: `{0283ac0f-fff1-49ae-ada1-8a933130cad6}`
- 요청 signing level: `2`
- 검증 signing level: `1`
- 차단 상태: `0xc0e90002`
- 이벤트의 SHA-256 Flat Hash와 실제 차단 EXE의 SHA-256이 정확히 일치
- 실제 EXE의 Authenticode 상태: `NotSigned`
- 같은 Activity ID의 `3089`: `TotalSignatureCount=0`
- AppLocker가 아니라 Code Integrity/Smart App Control 계층에서 차단

`3033` 하나만으로 unsigned를 판정한 것이 아니다. `3077` 정책 차단,
상관된 `3089` signature count `0`, Authenticode `NotSigned`, SHA-256 Flat Hash
일치를 함께 대조해 결론을 냈다.

## RED 결론

- Smart App Control을 끄거나 registry/policy를 변경하지 않았다.
- one-time hard gate를 재실행하지 않았다.
- mandatory ordinary suite도 다시 실행하지 않았다.
- 전체 Phase 0A는 계속 `Inconclusive`다.
- 실제 Secret, full VFS, store integration은 계속 금지다.
- 사용자 승인만으로 Draft PR을 병합하지 않는다. pinned-host ordinary suite가
  exit `0`으로 통과하거나, 별도 승인된 새 권위 검증 계약이 그 gate까지
  통과해야 한다.

## 다음 선택지

1. 신뢰된 RSA code-signing 기반 테스트 파이프라인을 별도 설계·검토한다.
2. 전용 Windows 검증 VM/CI 계약을 별도 설계한다. 다른 호스트의 결과는 현재
   pinned-host gate를 자동으로 통과시키지 않는다.
3. 기존 계획에 따라 broker/service-boundary 재설계 명세로 돌아간다.

운영체제 보안을 약화시키는 선택은 자동으로 하지 않는다.
Consumer Smart App Control에는 개별 앱 bypass가 없으며, self-signed/로컬 루트,
Public Trust Test/Private Trust, 임의 supplemental `.cip`를 이 gate의 대체
증거로 인정하지 않는다.
