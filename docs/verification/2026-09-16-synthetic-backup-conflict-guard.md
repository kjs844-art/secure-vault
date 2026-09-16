# 2026-09-16 합성 backup conflict guard 검증

이 변경은 합성 백업에 conflict outbox 후보를 새 형식으로 포함하지 않는다. 대신 보존
후보가 하나라도 남아 있거나 후보 목록을 신뢰성 있게 확인할 수 없으면 export를
fail-closed로 중단한다. 실제 자격 증명 또는 제품용 백업 승인이 아니다.

`REAL_SECRET_GATE=CLOSED`, `PHASE_0A_VERDICT=UNCHANGED`.

## 구현 경계

- export 시작 전과 main archive 인증 뒤 반환 직전에 conflict 목록을 다시 확인한다.
- bounded 배열, 정확한 own data property, plain/null-prototype entry, 32자리 소문자 ID,
  ID 중복과 일반 `ArrayBuffer` 기반 `Uint8Array`를 검사한다.
- getter, 추가 필드, 악성 Proxy, `SharedArrayBuffer`, 잘못된 bytes 또는 조회/인증 실패는
  `STORAGE_FAILED`로 닫고 main archive를 읽거나 export bytes를 반환하지 않는다.
- 인증된 후보가 하나라도 있으면 `UNRESOLVED_CONFLICTS`로 중단한다.
- conflict ID·bytes를 UI/오류에 넣거나 후보를 삭제·병합·승격·내보내지 않는다.
- store가 반환한 일반 conflict 사본과 내부 작업 사본은 작업 뒤 0으로 덮는다.
- 백업 화면은 실패 시 download URL을 만들지 않는다.

## 검증 증거

| 검사 | 결과 |
|---|---|
| backup + actual-WASM + session 집중 검사 | exit 0, **192/192** |
| 전체 Web `npm test -- --run` | exit 0, 25 files, **932/932** |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0, Vite 43 modules, WASM 313.18 kB |

## 남은 경계

현재 store API에는 “main archive 읽기 + conflict 없음”을 한 IndexedDB transaction으로
묶는 snapshot API가 없다. 두 번째 목록 확인이 끝난 직후 다른 탭이 새 conflict를 추가하는
작은 TOCTOU 구간은 남는다. 이번 guard를 outbox까지 포함한 원자적 제품 백업이라고
표현하지 않는다. 완전한 해결은 별도 store capability와 백업 wire/version 정책 검토가
필요하다.

실제 Chromium 다운로드·네이티브 파일 선택 왕복, 실제 Secret, 사용자 인증, 동기화와
복구 훈련은 검증하지 않았다.
