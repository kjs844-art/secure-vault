# KeyAtlas 자율 작업 상태표

기준: 2026-09-18, 현재 작업 브랜치 `codex/firstvibe-mixed-credential-archive`.
전체 목표는 사용자 결정(도메인, 배포, 디자인 등)을 제외한 구현·검증의 진행이다. 이 표는 범위를 줄인 완료 선언이 아니다. 제품 요구 기준은 [MVP](MVP.md)와 [보안 설계](SECURITY_ARCHITECTURE.md)를 유지한다.

## 최신 작업: 혼합 credential archive 경계

공통 이력 무결성과 API 키 전용 회전 권한을 분리했다. `credential_history`는 caller가 준 head와 전체 rooted ancestry를 인증하여 같은 record, 끊기지 않은 parent chain, 모든 revision의 동일 credential type을 확인한다. Password는 별도 classifier로 빌드에 포함된 정확한 비밀번호·식별자 및 필드/정책을 모든 허용 revision에서 검사한다. 단순히 Password이면 API 회전 검사를 건너뛰는 구현이 아니다.

- 공개 Rust 팩토리는 private builder를 재사용하지만 입력은 빌드에 포함된 닫힌 enum 2개뿐이다. 실제 문자열 입력·Secret reveal/copy·웹/Worker/JS/WASM 등록 경로는 추가하지 않았다.
- archive 모든 버전의 공통 읽기 경계에 Password admission을 적용했다. v1/v2 Password는 genesis만 허용하고 v3/v4는 모든 조상을 인증한다. 기존 API legacy snapshot 정책과 v4 API의 완전한 회전 ancestry 검사는 유지한다.
- Password를 선택한 connection edit/rotation/staging은 거부한다. 다른 API의 정상 stage/finalize와 전체 회전 이력, Password 암호문 보존은 혼합 통합 테스트로 확인한다. 미사용 stage 인증과 완료 공간 예약도 유지한다.
- 새 코어 집중 10+7 tests, core 전체 release 123 tests(19.71초), core Clippy와 native WASM archive 전체 69 tests(44.52초)가 통과했다. 69개에는 새 혼합 archive 9 tests가 포함된다. 독립 소스 리뷰는 Critical 0/Important 0이다. 새 default/demo WASM 40/1,528 checks와 workspace compile-fail 11개도 통과했다. WASM package Clippy는 Windows Code Integrity의 의존성 macro DLL 차단으로 exit 1이었다. 정책을 바꾸거나 우회하지 않았다. [혼합 금고 검증 기록](verification/2026-09-18-mixed-credential-archive.md)에 명령·한계·test-only 수정 이력을 구분한다.
- 직전 private-command 커밋 `238f8b8f97afd2bb27e3392593406fbe3a1e0612`의 [원격 CI 35291131952](https://github.com/kjs844-art/secure-vault/actions/runs/35291131952)는 exact SHA `completed/success`를 확인했다. 현재 mixed-archive 변경은 그 원격 실행에 포함되지 않으므로 이번 변경의 성공 증거로 재사용하지 않는다.
- 현재 트리의 웹 전체 42 files/1,360 tests(99.26초), typecheck, production build와 format/diff 검사도 exit 0이다. 새 Password 브라우저 입력 검증이 아니라 기존 UI/Worker/CAS 회귀와 새 생성 WASM 호환 확인이다.
- 실제 저장소 Secret scan은 baseline 4개와 `REAL_SECRET_GATE=CLOSED`를 확인하고 통과했다. baseline은 독립 리뷰를 받은 archive.rs의 exact hash만 갱신했으며 검사 규칙을 바꾸지 않았다. PS7 scanner 회귀 99개도 exit 0이다.

`REAL_SECRET_GATE=CLOSED`를 유지한다. 다음 단계는 이 기반 위의 닫힌 Password 선택·저장/복원 UI 계약과 소비자별 capability 표시를 연결하는 것이다. 실제 비밀번호/free-text 개방, 인증·복구 선택, 배포는 별도 보안/사용자 결정 경계다. 전체 목표는 아직 active다.

## 직전 작업: 공통 private credential command 경계

이번 코어 체크포인트는 `credential_commands.rs`에 API Key/Password 등록 item builder와 metadata-only successor를 공통 private 명령으로 분리했다. 기존 닫힌 합성 API Key 등록은 같은 builder를 재사용하므로 기존 선택형 UI/API의 입력 범위를 넓히지 않는다. Password variant는 Rust 내부 합성 테스트에서만 생성하며 웹·WASM·Worker·공개 API·free-text 입력에 노출하지 않았다.

- 등록 builder는 caller가 field ID나 lifecycle 상태를 정하지 못하게 하고, Rust RNG로 field ID를 만든다. Secret field는 재인증 뒤 reveal/copy 정책을 유지하며 새 item에는 parent·rotation·connection을 임의로 주입하지 않는다.
- metadata successor의 allowlist는 item name, notes, tags, updated time뿐이다. 인증된 predecessor와 공통 successor 경로를 사용하여 Secret/credential type/provider identity/field·record ID/connection/lifecycle·verification을 변경하지 않는다. 회전 진행 중 상태는 승격하지 않고 거부한다.
- 초기 집중 10 tests, 등록 7 tests와 보강 1 test에 이어 코어 전체 106 tests가 단일 스레드 exit 0으로 통과했다. 독립 읽기 리뷰 Critical 0/Important 0, 코어 Clippy, workspace compile-fail 11개도 통과했다.
- 새 default/demo release WASM smoke 40/1,528 checks, 웹 42 files/1,360 tests, 타입 검사·production build·Secret scan을 통과했다. [검증 기록](verification/2026-09-18-private-credential-commands.md)에 명령과 실패 후 재검사 이력을 구분한다. 기준 커밋 `238f8b8`은 원격에 있으나 그 CI는 마지막 조회에서 아직 진행 중이므로 성공으로 기록하지 않는다.
- 실제 브라우저에서 창 열기·잠금·부분 진행 저장/재열기와 bytes 보존을 확인했다. Offline Worker는 `ERR_ABORTED`/`BRIDGE_FAILURE`였고 완전한 오프라인 지원은 아니다. 실패 안내를 보완한 새 빌드에서도 안내·암호문 보존·온라인 복구 후 재열기를 확인했다. [브라우저 회귀 기록](verification/browser-2026-09-18/report.md)을 따른다.

`REAL_SECRET_GATE=CLOSED`다. 실제 비밀번호/API 키, 사용자 데이터, 임의 free-text, provider 호출은 받지 않는다. 이 체크포인트 뒤 generic full-chain archive integrity와 API-key 전용 회전 capability 분리는 위 최신 mixed-archive 작업에서 구현했다. Password 웹 등록과 실제 입력은 여전히 미래 범위이며, 인증·복구 방식과 도메인·배포·디자인은 사용자 결정 및 별도 보안 검토가 필요하다.

## 완료된 직전 체크포인트: 키 교체 완료 공간 예약

반복 중간 저장이 마지막 교체 공간까지 소진하지 않도록, 새 후보의 현재 head별로 완료 공간을 예약한다. 미완료 진행은 ready 저장과 최종 확정 2개 revision, ready 진행은 최종 확정 1개를 남겨둔다. 암호문 실제 크기는 코어 변환·CBOR·padding과 crypto serializer를 재사용해 계산하고 모든 새 변경 경로에서 합산한다. 기존 암호문/과거 진행은 자동 삭제하지 않으며, 과거 예약 없는 v4도 읽기·검토·백업을 유지한다.

- 현재 소스로 재생성한 default/demo WASM smoke **40/1,528 checks**, 웹 **41 files / 1,350 tests**, typecheck/production build, Secret scan/PS7 회귀 99개 통과.
- crypto lib 18개와 codec/vector 23개, core rotation 58개, scoped crypto/core Clippy, workspace compile-fail doctest 7개 통과. capacity 집중 7개와 독립 리뷰 Critical/Important 0 확인. 전체 archive 실행은 34개 PASS 뒤 64MiB 메모리 할당 실패(exit 1); 남은 21개를 단일 스레드로 실행해 모두 통과(exit 0)했다. 55개 개별 PASS 증거와 단일 전체 실행 성공은 구분한다.
- 금고 내부 512 revisions/512 KiB 예산의 보장이며 실제 디스크/IndexedDB quota/충돌 보관함 여유를 보장하지 않는다. 새 저장본의 완료 경로를 보호하는 것이지 과거 꽉 찬 저장본이나 무제한 저장까지 보장하는 것은 아니다.
- 기존 staging 커밋 `c0dedd4`의 원격 CI를 취소하지 않도록 이 보완은 별도 `codex/firstvibe-rotation-capacity` 브랜치와 커밋 `0ec551a`로 분리했다. `main`은 변경하지 않았다.
- 이후 기존 `c0dedd4`의 [원격 CI 35283835489](https://github.com/kjs844-art/secure-vault/actions/runs/35283835489)가 전체 SUCCESS로 완료됐다. 이 결과는 이번 capacity 변경의 CI 성공을 뜻하지 않는다. 추가 browser smoke는 도구 연결/메모리 문제로 미완료이며 다른 앱 종료나 OS 보안 정책 변경은 하지 않았다.
- capacity 커밋 `0ec551a`의 [원격 CI 35287783960](https://github.com/kjs844-art/secure-vault/actions/runs/35287783960)은 `completed/success`로 완료됐고 head SHA도 일치했다. 이후 private command 변경의 CI 증거로 혼용하지 않는다.

[이번 파일 역할·정확한 검사·한계](verification/2026-09-18-rotation-capacity-reservation.md)를 최신 기준으로 본다. 실제 Secret gate는 계속 닫혀 있고 전체 자율 목표는 active다.

## 직전 체크포인트: 합성 교체 진행의 암호화 저장·재개

중간 진행 저장 → 잠금/새로고침 → 저장된 진행 인증·복원 → 남은 확인 저장 → 새 동의 → 최종 교체를 코어부터 웹 화면까지 연결했다. Archive v4는 진행 후보를 canonical head와 분리하여 보관하며 기존 암호문·완료 이력을 보존한다. 기존 v1/v2/v3 읽기, 연결 편집, 충돌 후보 보존, 백업/복원은 유지한다.

- 최종 웹 전체 **41 files / 1,346 tests**, 타입 검사·production build·default/demo 실제 WASM smoke·Secret scan 통과. 실제 WASM + fake IndexedDB의 저장/재개/확정 및 v4 백업복원도 통과했다.
- 실제 격리 브라우저 Worker/WASM/IndexedDB에서 일부 확인 저장·새로고침 복원·새 동의·최종 두 번 클릭 한 번 확정을 확인했다. 콘솔은 favicon 404 한 건이 남아 있어 무오류라고 주장하지 않는다.
- 코어 rotation 55 tests, archive 47 tests 및 마지막 보강된 staging 12 tests, workspace compile-fail doctest 7개 통과. 독립 소스 리뷰 최종 Critical/Important 0.
- **전체 검증 완료는 아님:** 앱 제어가 WASM 매크로 DLL과 workspace 비밀 타입 테스트 실행을 차단했고, Windows PowerShell 5.1은 실행 정책에 막혔다. 설정을 우회하지 않았다. exact-branch 원격 CI 확인이 필요하다.
- 이 체크포인트 당시 총 512 revisions/512 KiB 한도에는 중간 후보도 포함해 가득 차면 최종 확정도 거부됐다. 위 capacity 후속 작업에서 신규 저장의 완료 공간 예약을 추가했다. 실제 Secret gate는 닫힌 상태다.

[당시 변경 파일 역할·정확한 명령·브라우저 증거·미검증 범위](verification/2026-09-18-durable-synthetic-rotation.md)를 참고한다. 이전 UI `bbbe899`의 원격 CI run `35242399539`는 성공했으나 후속 구현의 CI 증거로 재사용하지 않는다.

## 누적 구현 이력

아래는 각 이전 단계 당시의 증거다. '미구현/미확인' 표기는 해당 시점의 경계이며, 중간 저장 기능의 최신 상태는 위 체크포인트를 우선한다.

별도 `codex/firstvibe-synthetic-rotation-checklist` 체크포인트: 합성 연결처의 필수 완료 조건을 확인하고 최종 암호문 후보만 생성하는 코어를 추가했다. 새 코어 11 tests와 SQLite 충돌/재실행 테스트를 포함해 Node 타입 수정판 `06349e8`의 원격 run `35106829156`이 전체 성공했다. 기존 PR #4의 `ce518ee`도 run `35106625311` 전체 성공을 확인했다. 로컬 Windows 앱 제어 4551 정책은 변경하지 않았다. 단발성 코어이며 후속 회전·연결 편집·UI는 미지원이다. [검증 기록](verification/2026-09-16-synthetic-rotation-cutover.md)을 참고한다.

현재 후속 작업: archive와 conflicts의 원자 snapshot 및 인증 후 exact-byte 재확인으로 백업 중 저장 경합을 닫았다. 로컬 22파일 965 tests와 독립 소스 리뷰를 통과했고, 원격 run `35112935398`도 Secret/Rust/WASM/web 전체 gate 성공으로 끝났다. [구현·검증 경계](verification/2026-09-17-atomic-backup-snapshot.md)를 참고한다.

완료된 lifecycle/history 기준 작업: 완료된 합성 회전 event가 붙은 revision 뒤의 일반 편집을 허용하되 새 successor payload에서만 event를 비우고 과거 암호문은 바꾸지 않도록 했다. metadata만 조작한 `0001`, 비정상 optional 연결, 비연속 세대와 legacy incomplete event는 읽기 호환성을 유지하면서 generic/no-op/연결 편집/다음 회전과 RNG 전에 fail-closed한다. 합성 값 `0001→0002→0003`의 두 차례 회전과 그 사이 편집을 지원하며, caller가 제공한 head와 모든 ancestor를 인증·연결하고 세대 연속성을 확인한 뒤 Secret/메모 없이 회전 event만 최신순으로 돌려주는 bounded history API를 추가했다. 기준 커밋 `8ef81d9`는 원격 run `35119009675` attempt 2에서 모든 step이 `SUCCESS`로 끝났다. 이는 provider 갱신/폐기 증명, latest-head/rollback anchor, 웹·WASM·Android workflow가 아니다. [lifecycle/history 검증 기록](verification/2026-09-17-synthetic-rotation-lifecycle-history.md)을 따른다.

현재 rotation archive/WASM slice: 인증된 합성 archive head에서 고정 generation·fixture·필수 여부·남은 개수만 투영하는 checklist와, 원본 revision을 다시 쓰지 않고 선택한 head에만 새 합성 cutover 후보를 붙이는 내부 경로를 추가했다. JavaScript 표면은 `synthetic-demo` 전용이며 primitive boolean/number만 엄격히 받고 임의 Secret·문자열·provider 자료를 받지 않는다. 최종 현재 트리에서 `vault-client-wasm` 합성 demo 40 tests, default release WASM runtime 32 checks, demo release WASM runtime 1520 checks(5 checklist, 2 cutover, 100 rejection)와 직접 constructor의 고정 `Error("CONSTRUCTOR_DISABLED")` 거부가 통과했다. 손상 archive의 신규 API 거부, `0002→일반 편집→0003` 부모 연결, 0002/0003 후보의 합성 평문 비노출도 별도 회귀로 고정했다. 코어 checklist 8 tests, Secret scanner 회귀 양쪽 99 tests, 실제 저장소 scan, Node 문법·format·Clippy·diff, 웹 25 files/997 tests·typecheck·production build도 통과했다. 이전 generated WASM 부재 실패는 생성 전 과거 시도이며 현재 증거가 아니다. 이 브랜치 exact SHA의 원격 CI 성공은 아직 주장하지 않는다. [부분 검증 기록](verification/2026-09-17-synthetic-rotation-archive-wasm.md)을 따른다.

현재 Worker/Client slice: 닫힌 합성 rotation 선택을 Worker 전에 검증·복사하고, 실제 demo WASM checklist/cutover를 작업별 고정 응답으로 연결했다. checklist handle은 두 차례 exact boolean lock 상태를 확인한 뒤 lock/free되고, structured clone 뒤에도 client가 고정 필드·상태 불변식을 다시 검증해 frozen projection만 공개한다. cutover ciphertext는 경계마다 복사하고 Worker 소유 buffer만 transfer한다. 첫 RED 리뷰의 truthiness fail-open Important 1건은 두 검사와 10개 회귀로 수정했으며 독립 재리뷰는 Critical/Important 0이다. mock 경계뿐 아니라 실제 생성 WASM handle과 어댑터의 결합도 별도 검사했다. 저장 CAS와 UI는 아직 연결하지 않았다. [검증 기록](verification/2026-09-17-synthetic-rotation-worker-client.md)을 따른다.

현재 rotation Session/IndexedDB CAS slice: 표시 중인 authenticated bytes·vault generation·review version을 exact snapshot으로 묶고, 후보를 저장 전에 인증한 뒤 conflict-preserving CAS를 한 번만 수행한다. 경쟁 패자와 CAS 직후 displacement된 세션 후보는 bounded conflict outbox에 보존하며, authoritative readback의 byte equality와 재인증이 끝나기 전에는 성공을 게시하지 않는다. getter/subscriber 재진입, stale 두-token replay, hostile result, alias mutation, 모든 await 단계의 lock과 임시 ciphertext wipe를 회귀로 고정했다. 실제 WASM+fake IndexedDB 3 tests, 관련 9 files/210 tests, 전체 웹 32 files/1161 tests, typecheck/build/Secret scan을 통과했고 독립 최종 RED는 Critical/Important 0이다. 실제 browser Worker/IndexedDB 또는 UI 완료 증거는 아니다. [검증 기록](verification/2026-09-17-synthetic-rotation-session-cas.md)을 따른다.

현재 키 교체 화면: 합성 항목·연결처 확인 선택 → 검토 → 명시적 동의 → 기존 CAS 저장을 연결했다. 최종 ready 알림 이후에도 유효한 검토만 frozen receipt를 반환하고, 화면은 그 receipt의 version과 모든 선택 필드를 저장 조건에 묶는다. initial RED Important 1의 재진입 결합 문제를 고쳤고 재개 후 독립 리뷰도 Critical/Important 0이다. 최종 웹 33 files/1169 tests, 타입 검사를 포함한 production build, 절대 경로 Secret scan이 통과했다. 실제 브라우저에서 발견한 중복 항목명 표시를 예시 번호로 구분한 뒤 관련 41 tests와 build도 통과했다. 격리 브라우저의 실제 Worker/WASM/IndexedDB로 검토 후 선택 변경 차단, 두 번 클릭해도 한 번 교체, 새로고침 뒤 0002 복원, 두 번째 교체와 terminal_0003 추가 저장 차단을 확인했다. 모바일 검증 중 브라우저가 재연결되어 그 이후 범위는 미검증이다. 중간 체크리스트 저장도 아직 없다. [현재 검증 기록](verification/2026-09-18-synthetic-rotation-ui.md)을 따른다. 기준 Session/CAS 커밋 `7d61e9a`는 실제 GitHub 원격과 일치함을 재확인했다.

## 기존 단계별 증거와 미해결 경계

| 항목 | 현재 증거 | 남은 일 |
|---|---|---|
| 암호화/필드 보존 | 기존 코어, 후속 67개 필드 비교 검사 cherry-pick | 통합 상태의 네이티브 회귀, 독립 리뷰 |
| 로컬 웹 저장/복원 | IndexedDB·Worker·WASM 구현, 통합 웹 전체 932 tests; 합성 등록 후 저장본 재열기·새로고침 확인, v3 편집·충돌 보존·검토 UI·백업 guard는 실제 WASM+fake IndexedDB 검증 | 파일 다운로드 경로, 실제 브라우저 다중 writer/오프라인 통합 검사 |
| 자동 잠금 | 5분/숨김/절전 후 만료/시계 오류 처리, 신규 18 tests | 실제 브라우저·모바일 수명 주기 확인 |
| 키와 연결처 목록 | 계정/workspace/project/환경 private projection·검색; 실제 Comet에서 3→6개 등록, 0/1/3 연결과 순서 보존, 검색·잠금·재열기·360px 검사 | 임의 데이터 수동 등록/편집, 회전 체크리스트, 실제 모바일/큰 목록 검증 |
| 합성 백업/복원 | 기존 guard 후속으로 한 readonly transaction의 archive+conflicts snapshot 2회와 인증 bytes 비교, raw 원본 보존; Store 122/Backup 167/Session 47 tests 통과 | 해당 백업 checkpoint의 actual-WASM·전체 CI, 실제 브라우저 경합·다운로드·네이티브 파일 선택 왕복 미검증. 마지막 snapshot 이후 변경은 포함하지 않음. 실제 데이터용 기능 아님 |
| 로컬 도구 경계 | 입력 64 tests + 세션 62 tests; 격리 Comet 검색/분류/잠금/재열기/숨김 검사, 중복 React key 수정 후 콘솔 경고 0 | 외부 AI/MCP 연결·개인 projection 승인 아님; 실제 모바일 검증 별도 |
| 웹 등록 화면/저장 경로 | 닫힌 2프로필/0~3연결 폼 → archive v2 → Worker/세션 CAS → 저장본 전체 재인증; 실제 브라우저 이중 클릭 한 번 저장·계정 정보 보존·탭 전환 잠금 확인 | 합성 선택형만 지원. 편집 UI 실제 저장/회전·rollback/누락 보장은 아직 없음 |
| mixed credential command/archive | 공통 API Key/Password builder와 metadata-only successor, 공개 Rust closed-enum Password factory, 모든 조상의 same-record/parent/constant-type 검사. v1/v2 Password genesis-only, v3/v4 full ancestry이며 API v4 회전 이력은 보존. 집중 10+7, core release 123, native WASM archive 69 tests, core Clippy, 독립 리뷰 Critical/Important 0 | WASM package Clippy는 OS macro DLL 정책 차단, mixed exact-SHA CI 미확정. Password connection edit/rotation/staging capability와 웹/Worker/JS/WASM 등록/free-text/실제 Secret 입력은 없음 |
| 웹 연결 편집 내부 경로 | 같은 record의 successor·immutable v3 이력/명시적 head·표시 bytes+generation 결합·후보 사전 인증·원자 CAS/재인증, Rust release 30 tests 및 실제 demo WASM 973 checks | 실제 브라우저 편집 Worker/IDB 미검증, 회전·signed rollback/누락 anchor 미구현 |
| 합성 회전 lifecycle/history | 완료 event를 revision-local 기록으로 보존하고, 인증된 successor에서만 event를 비운 뒤 일반·연결 편집과 두 번째 합성 회전을 진행. 최대 512 revisions/8 MiB의 caller-supplied chain 전체와 `0001→0002→0003` 세대 연속성을 인증하고 회전 event의 opaque ID·bounded counts·enum만 최신순 projection. 기준 `8ef81d9`의 원격 run `35119009675` attempt 2 전체 성공 | 중간 checklist 저장, provider 실제 증명, latest-head/rollback anchor, 웹·Android 연결 미구현 |
| 합성 회전 archive/WASM | 인증된 선택 head에서 고정 checklist를 투영하고 v1/v2 genesis를 v3 history로 옮기거나 `0001→0002→0003` 후보를 생성한다. 기존 envelope와 다른 head를 보존하고 선택 head만 전진시키며 assembled archive를 다시 인증한다. JS API는 `synthetic-demo` 전용, 직접 생성 거부/getter-only/lockable checklist와 엄격한 primitive 입력만 노출. 최종 native 40 tests, default release WASM 32 checks, demo release WASM 1520 checks(5 checklist, 2 cutover, 100 rejection), 웹 25 files/997 tests·typecheck·production build 통과 | 현재 branch exact SHA 원격 CI, 저장 CAS, Worker/session/UI, 실제 Secret/provider proof, latest-head/rollback anchor 미검증 |
| 합성 회전 Worker/Client | exact 5-field 선택 parser, 실제 WASM handle 소유 adapter, Worker의 checklist/cutover dispatch와 client structured-clone 재검증을 구현. 입력·출력 복사, lock/free, 고정 오류, 취소·timeout·늦은 응답, 동기 transport 실패, owned transfer/detach를 회귀로 고정. 독립 수정 후 RED Critical/Important 0 | 실제 브라우저 Worker 왕복과 UI 미구현 |
| 합성 회전 Session/IndexedDB CAS | 현재 표시 bytes·vault generation·review version을 exact 결박하고 후보 사전 인증 → conflict-preserving CAS 1회 → authoritative reread byte equality → 재인증 뒤에만 성공 게시. CAS loser와 post-CAS displacement candidate를 정확한 bytes로 conflict 보존하며 fallback/retry/merge/overwrite 없음. unit 33, 실제 WASM+fake IDB 3, 관련 9 files/210, 전체 웹 32 files/1161 tests와 RED Critical/Important 0 | 실제 browser Worker/IndexedDB·멀티탭/오프라인·UI, 실제 Secret/provider proof, signed latest-head/rollback/누락 anchor 미검증 |
| 합성 키 교체 UI | 고정 항목/연결처 선택, receipt 일치·동의 후 저장. 최종 전체 웹 33 files/1169 tests, 관련 41 tests·build, 독립 RED Critical/Important 0. 실제 브라우저의 두 번 클릭·0001→0002→0003 저장·새로고침 재열기·terminal 차단 확인 | 모바일/포커스·멀티탭·오프라인 및 required-pending 실제 브라우저 검증은 남음. 중간 진행 상황 암호화 저장/재개 미구현. 실제 Secret 입력은 계속 닫힘 |
| 암호문 conflict outbox | DB v1/store 유지, 최대 8개 무퇴거 후보, CAS loser 보존, 전체 인증 뒤 위치 기반 검토, exact-byte 2단계 폐기, 미해결 후보 backup 차단 | 자동 병합·승격 정책과 outbox 포함 백업 형식, 실제 브라우저 멀티탭·모바일 검증 |
| 웹 연결 편집 UI | 검토 UI 포함 통합 웹 932 tests, typecheck/build exit 0; 독립 보안 리뷰 Critical/Important 0 | 저장/취소/포커스/잠금·멀티탭 충돌의 실제 브라우저 검증과 모바일 검증 |
| 공유 메모리 입력 경계 | Store·Session·Worker client/worker·Backup에서 SharedArrayBuffer를 DB/Worker/WASM 작업 전에 고정 오류로 거부 | cross-origin-isolated 실제 브라우저의 동시 변경 통합 검사는 미실행 |
| 원격 CI 보안 gate | `ce518ee`, `06349e8`, atomic-backup run `35112935398`, lifecycle/history `8ef81d9` run `35119009675` attempt 2, staging `c0dedd4` run `35283835489`, capacity `0ec551a` run `35287783960`, private-command `238f8b8` run `35291131952`의 성공 확인 | 현재 mixed 변경 exact-SHA CI는 별도. branch protection과 ignored 보안 gate 승인은 별도 |
| SQLite 읽기 전용 preflight | 8 DB_CONFIG를 첫 SQL 전에 적용하고 query_only와 공통 hardening을 읽기 전용 연결에도 강제; 패키지 91 passed/1 ignored, 독립 재리뷰 Critical/Important 0 | 악성 schema 실제 통합 fixture와 WR 대칭 profile assertion은 residual |
| 네이티브 전체 QA | `5d439eb` 기능 묶음 기준 Workspace Secret scan·format·Clippy·tests·ordinary VFS·doctests exit 0. 후속 scanner-only 트리는 집중 회귀와 실제 저장소 scan 통과 | 후속판 전체 Workspace 재실행과 명시적으로 ignored인 Phase 0A 보안 gate·권위 승인은 별도 필요 |

## 이어서 할 수 있는 구현

1. 합성 백업·복원의 디스크 다운로드/네이티브 선택 검증을 지원되는 환경에서 보완한다. 브라우저 File API로 전달한 검사는 실제 파일 다운로드 성공과 구분한다. [통합 검증 기록](verification/2026-09-15-backup-session-integration.md)을 따른다.
2. 연결된 합성 편집 UI의 [부분 검증 기록](verification/2026-09-15-synthetic-connection-editor-ui.md)에 따라 실제 브라우저 저장/취소/포커스/잠금/변경/충돌을 검증한다. row reference와 generation은 같은 표시 snapshot에서 캡처하며 합성 선택형과 Claude Code 디자인 경계를 보존한다.
3. 중간 회전 진행 저장·재개·최종 확정과 새 저장의 완료 공간 예약을 연결했고 capacity SHA CI도 통과했다. 실제 브라우저 다중 writer·오프라인·모바일 생명주기 검증을 이어간다. 자동 retry·merge·overwrite 없이 현재 snapshot과 conflict 보존 원칙을 유지한다.
4. durable conflict outbox의 저장·인증 목록·명시적 exact-byte 폐기와 백업 차단 경계는 구현했다. 중간 회전 저장과도 결합했다. 다음 실제 브라우저 다중 창 경합·폐기·백업 guard를 확인한다. 자동 재시도·병합·승격·퇴거는 열지 않는다.
5. generic full-chain archive integrity와 API-key 전용 회전 capability 분리는 구현했다. 남은 검증 gate를 통과한 뒤 닫힌 합성 Password enum 선택형을 Worker/session/UI 저장·복원에 연결한다. 닫힌 합성 UI는 자율 작업 범위지만, JS/WASM free-text 입력과 실제 Secret은 별도 사용자 승인·인증/복구 결정·보안 gate 전에는 열지 않는다.
6. 외부 계정 없이 검증 가능한 API 계약·동기화 충돌 모델·로컬 테스트 환경을 명세에 맞춰 준비한다. 클라우드 연결을 했다고 주장하지 않는다.
7. 보안 수명 주기·복구·기기 해제의 미결 설계와 구현 증거를 비교하고, 사용자 선택이 필요한 부분과 독립 리뷰가 필요한 부분을 분리한다.

각 항목은 테스트·빌드·실제 동작 범위를 명시한 체크포인트로 남긴다. 모두 끝날 때까지 목표는 active이며 좁은 테스트 통과를 서비스 완성으로 대체하지 않는다.

## 사용자 또는 별도 권한/리뷰가 필요한 경계

- 서비스명/도메인, 최종 디자인, 공개 배포, 운영 DB/IAM 및 결제 계정 선택.
- 가격·결제 활성화, 개인정보·법률 문서 확정, 앱스토어 제출.
- 실제 Secret 입력 개방, 사용자 키/복구 방식의 미결 결정 및 독립 보안 검토.
- OS 앱 제어 정책 변경/예외는 자율 실행 범위 밖. main 병합도 별도 승인 대상.

현재 사용자에게 위 항목을 즉시 결정하라고 요구하지 않는다. 안전하게 독립 진행할 수 있는 구현이 남아 있다.

## 현황 공유·다른 기기 협업

[2026-09-15 갱신 공유 가이드](KEYATLAS_PROJECT_SHARED_GUIDE.md)에 조건부 기간, 작업 경로, 역할/브랜치 제안 및 병렬 협업 범위를 정리했다. 같은 본문을 사용자 요청의 바탕화면 파일에도 반영했다. 이전 9월 12일 본문은 archive에 보존한다.
기기 연결·원격 제어·연산 오케스트레이션은 KeyAtlas 밖의 비공개 운영 저장소에서 관리한다. KeyAtlas에는 별도 clone/worktree, 담당 파일, base/head SHA, 재현 가능한 검사 명령과 종료 코드만 남기며 장치·계정·접근 설정은 기록하지 않는다.
