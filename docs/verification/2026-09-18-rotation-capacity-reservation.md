# 키 교체 완료 공간 예약: 구현·검증 기록

날짜: 2026-09-18. 브랜치: `codex/firstvibe-rotation-capacity`.
시작 커밋: `c0dedd40c2fa518e172bfc039427515edb223a18`.
`REAL_SECRET_GATE=CLOSED`. 실제 비밀번호/API 키, 공급자 API, 클라우드 배포를
사용하지 않은 합성 데이터 전용 변경이다. 전체 서비스 완료 선언은 아니다.

## 무엇이 달라졌나

중간 저장을 반복해서 금고를 채운 뒤 마지막 키 교체를 못 끝내는 상황을
막는다. 새 저장을 승인하기 전에 현재 금고의 모든 진행 상태를 검사하고
각 교체를 완료할 공간까지 계산한다. 기존 암호문/이력은 자동 삭제하지 않는다.

| 저장된 최신 진행 | 남겨두는 revision 수 | 이어서 할 수 있는 완료 경로 |
| --- | ---: | --- |
| 아직 미완료 | 2 | 필요한 확인을 모아 ready 저장 → 최종 확정 |
| ready | 1 | 저장한 진행 검토·새 동의 → 최종 확정 |
| 확정되어 head 전진 | 0 | 과거 진행은 보존하되 활성 예약에서 제외 |

이것은 **archive 내부 512 revisions / 512 KiB 예산**의 보장이다. 디스크,
IndexedDB quota, 충돌 후보 보관함, 공급자 동작, 인증 성공, OS 안정성까지
보장하지 않는다. 이미 예약 없이 꽉 찬 과거 저장본에는 소급 보장이 없지만
열기·검토·백업을 막지 않는다. 새 회전을 무제한 시작할 수 있다는 뜻도 아니다.

## 파일과 연결 구조

```text
기존 저장본 + 새 변경 후보
  → archive.rs: 전체 후보 인증
  → archive_capacity.rs: 현재 head마다 최신 stage 예약 합산
      → rotation_staging.rs: base/stage 인증 + 실제 변환의 크기 산정
      → persistence.rs: 실제 successor와 같은 parent/CBOR/padding 처리
      → crypto codec.rs: 실제 serializer와 공유하는 envelope 길이 계산
  → 실제 사용량 + 예약량 ≤ 한도인지 확인
  → 통과한 후보만 기존 Worker/Session/CAS 저장 경로로 반환
```

- `archive_capacity.rs`와 테스트: pending 2개/ready 1개, stage framing 8 bytes,
  canonical final framing 4 bytes, checked arithmetic을 사용한다. 최종 후보의
  head를 기준으로 계산하므로 자기 예약을 소비하는 확정을 잘못 거부하지 않는다.
- `archive.rs`: 등록, 연결 편집, 단발 교체, 중간 저장, 저장된 진행 확정의
  공통 mutation 검증 지점에 연결했다. 읽기/복원 validator에는 넣지 않았다.
- `rotation_staging.rs`, `persistence.rs`, `rotation.rs`: 실제 닫힌 변환을
  재사용해 최대 ready 후보와 최종 후보를 산정한다. 크기를 재기 위해 RNG를
  쓰거나 버릴 암호문을 만들지 않는다. 임시 평문 인코딩 버퍼는 기존 zeroizing
  경계를 유지한다. 공개 API에는 길이만 반환한다.
- crypto `codec.rs`/`record.rs`: 공유 prefix encoder와 length-only writer를
  사용한다. core에 암호문 고정 overhead 숫자를 복제하지 않았다. 모든 padding
  bucket과 epoch의 CBOR 정수 폭 경계에서 실제 sealing 길이와 비교했다.
- `LocalVaultPanel.tsx`, `SyntheticRotationStagePanel.tsx`: 한도 안내와
  저장본 재확인 안내를 추가했다. ready가 된 뒤 다시 pending으로 바꾸는 저장은
  더 많은 공간이 필요해 거부될 수 있다. 자동 초기화·삭제·재시도는 추가하지 않았다.
- 웹 회귀: save/finalize의 `LIMITS_EXCEEDED`에서 CAS와 재시도가 없고 원본을
  다시 열 수 있는지 확인했다. 기존 v4의 512-count/512KiB 백업 호환성은 mock
  인증 전제로 별도 확인했다. mock fixture를 실제 인증 성공 증거로 취급하지 않는다.

## 실행한 검증

아래 명령은 저장소 root 기준이며 npm만 `apps/web`에서 실행했다.

| 정확한 검사 | 결과 |
| --- | --- |
| `cargo test --offline --locked -p vault-crypto envelope_length_matches -- --test-threads=2` | exit 0; 1 passed, 4 buckets × 8 epochs × 2 payload sizes |
| `cargo test --offline --locked -p vault-crypto --lib -- --test-threads=2` | exit 0; 18 passed |
| `cargo test --offline --locked -p vault-crypto --test codec_limits --test vectors -- --test-threads=2` | exit 0; 22 codec + 1 compatibility vector passed |
| `cargo test --offline --locked -p vault-local-core --lib rotation -- --test-threads=2` | exit 0; 58 passed, staging 12 포함 |
| `cargo clippy --offline --locked -p vault-crypto -p vault-local-core --all-targets -- -D warnings` | exit 0 |
| `cargo test -p vault-client-wasm --features synthetic-demo --lib archive::capacity --offline --locked -- --test-threads=2` | exit 0; 7 passed; 후속 ready→pending 검사도 전체 회귀에서 통과 출력 확인 |
| `cargo test -p vault-client-wasm --features synthetic-demo --lib archive:: --offline --locked -- --test-threads=2` | exit 1; 최신 소스 34개 PASS 뒤 64MiB memory allocation failure |
| 아래에 적은 잔여 archive 검사 명령, `--test-threads=1` | exit 0; 미완료 21개 모두 passed |
| `cargo test --offline --locked --workspace --doc` | exit 0; compile-fail 7 passed |
| `cargo fmt --all -- --check` | 최종 exit 0 |
| `pwsh -NoProfile -NonInteractive -File scripts/build-wasm.ps1 -Release` | exit 0; 현재 소스의 default release WASM |
| `pwsh -NoProfile -NonInteractive -File scripts/build-wasm.ps1 -SyntheticDemo -Release` | exit 0; 현재 소스의 demo release WASM |
| `node scripts/test-wasm.mjs` | exit 0; default 40 checks |
| `node scripts/test-wasm.mjs --demo` | exit 0; demo 1,528 checks |
| `npm test -- --maxWorkers=1` | exit 0; 41 files / 1,350 tests |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0; 48 modules, WASM 453,392 bytes |
| `pwsh -NoProfile -NonInteractive -File scripts/check-repository-secrets.ps1 -Root <this-worktree>` | 최종 exit 0; baseline 4, `SECRET_SCAN_PASSED` |
| `pwsh -NoProfile -NonInteractive -File tests/verification/check-repository-secrets.Tests.ps1` | exit 0; 99 passed |
| `git diff --check` | exit 0; 최종 문서 변경도 커밋 전 재확인 |

잔여 검사의 정확한 명령(같은 최신 소스, 단일 스레드):

```powershell
cargo test -p vault-client-wasm --features synthetic-demo --lib --offline --locked -- archive::staging::tests::required_connection_and_revocation_must_both_be_saved_before_finalization archive::staging::tests::save_reopen_update_and_finalize_preserves_siblings_until_head_cas_candidate archive::staging::tests::stages_never_serialize_plaintext_metadata_selection_or_password archive::staging::tests::v4_encoder_shares_canonical_and_stage_count_and_byte_budgets archive::tests:: --test-threads=1
```

최신 소스의 archive 55개 **각각** PASS 증거를 확보했지만 전체 55개를 한 번에
실행한 명령의 성공 종료는 확보하지 못했다. 해당 한계를 성공으로 바꿔 쓰지 않는다.

실제 production build 자산: `index-D-CQsV21.js`,
`syntheticVault.worker-xgZH6uuT.js`, `vault_client_wasm_bg-DiG8IIhf.wasm`.
현재 변경의 웹 검증은 Node actual-WASM + fake IndexedDB 및 mock/SSR 테스트다.
추가 브라우저 확인은 localhost:4182 production preview와 별도 named session을
준비했으나 `agent-browser`의 CDP 연결이 닫혀 페이지 상태를 얻지 못했다.
`doctor --offline --quick` 실행도 PowerShell out-of-memory로 종료했다.
이 확인을 통과라고 주장하지 않으며 브라우저 클릭/멀티탭/모바일/파일 선택은
미검증이다. Preview는 `q`+Enter로 정상 종료했고, 시작한 전용 CLI와 자식
`chrome.exe --version` probe만 소유 관계·명령줄 확인 후 정리했다.
사용자 브라우저/다른 Node·IDE 프로세스는 종료하지 않았으며 도구 재설치도 하지 않았다.

## 경계 테스트와 독립 검토

- 실제 암호문으로 한도 직전 저장본을 만들고, 반복 pending 저장과 다른
  항목 등록/편집/교체는 거부하지만 ready 저장 → 최종 확정은 성공함을 검사했다.
- ready → pending으로 예약이 증가하는 저장의 거부와 기존 bytes 보존을 검사했다.
- 여러 head의 최신 활성 진행만 합산하고 자기 head 전진 시 자기 예약만
  해제함을 검사했다. 과거/inactive stage 암호문은 모두 보존한다.
- count/byte 한도와 정확히 같은 경우 통과, 1 초과와 산술 overflow 거부.
  실제 archive framing 길이와 수학적 예산 검사를 함께 확인했다.
- 3개 연결처의 가능한 상태 중 유효한 51개 조합을 2개 교체 세대에서
  실제 stage/final envelope와 비교했다. payload 4,092/4,093 bytes에서
  padding bucket이 커지는 경우에도 현재 stage 크기가 아닌 미래 크기를 예약한다.
- 독립 production source review: Critical 0 / Important 0. 전문 외부 감사나
  실제 Secret 입력 개방 승인과는 다르다.

## 실패했던 시도와 수정

- crypto 신규 테스트의 bucket 소유권 오류(E0382)를 test-only clone으로 수정했다.
- 최초 staging run: 11 passed / 1 failed. MultipleConsumers fixture가 기본적으로
  모두 optional인데 테스트에서 두 연결을 required라고 가정한 오류였다.
  test-only fixture에 required를 명시하고 최종 rotation 58개 전체가 통과했다.
- 해당 테스트 수정 뒤 rustfmt 줄바꿈 차이 1곳을 정리하고 전체 format을 재확인했다.
- 전체 archive run은 `memory allocation of 67108864 bytes failed`, test exe
  `0xc0000409`, Cargo exit 1로 끝났다. 같은 최신 소스에서 이미 통과한 34개와
  나머지 단일 스레드 21개 결과를 분리 기록했다. 코드 assertion 실패를 고쳤다는
  의미도, 전체 workspace 성공이라는 의미도 아니다.
- 첫 저장소 Secret scan은 `setup_or_execution`, exit 1이었다. 이 출력만으로
  정확한 원인은 확정할 수 없다. 이후 빌드/소스 쓰기가 끝난 상태에서 같은
  명령을 재실행해 exit 0을 확인했다. 검사 규칙/시간 한도/OS 정책은 약화하지 않았다.
- scanner allowlist는 검토한 `archive.rs`의 정확한 normalized hash만
  `0CE85B615730757618610C98C53D21CBA570AC0D80AB7FD8FB324904EE9E5B5A`로
  갱신했다. 해당 파일의 변경은 capacity module과 공통 candidate hook뿐이다.
  나머지 3개 baseline과 탐지 패턴은 변경하지 않았다.

## 미검증/다음 작업

- 이번 트리의 전체 workspace Rust test/Clippy, 로컬 PowerShell 5.1 gate는
  통과라고 보고하지 않는다. 이전 실행의 Windows AppControl/스크립트 정책
  차단은 [직전 기록](2026-09-18-durable-synthetic-rotation.md)에 남아 있고
  정책 우회나 예외를 설정하지 않았다.
- 기준 커밋 `c0dedd40c2fa518e172bfc039427515edb223a18`의 원격
  [run 35283835489](https://github.com/kjs844-art/secure-vault/actions/runs/35283835489)는
  최종 `completed/success`를 확인했다. 그 결과와 이번 변경의 후속
  exact-commit CI를 구분해야 한다.
- 같은 브랜치 push가 기존 CI를 취소하는 concurrency 설정을 확인했으므로
  이번 보완은 별도 capacity 기능 브랜치로 분리했다. 기존 workflow 설정과
  진행 중인 staging CI는 변경하거나 취소하지 않았다. 작업 폴더는
  `secure-vault-rotation-staging` 그대로이며 폴더를 이동하지 않았다.
- 실제 브라우저 다중 writer/오프라인/모바일 수명 주기, 백업 파일 선택·다운로드
  검증은 후속으로 남는다. 새로운 실제 Secret/provider/복구/배포 권한을 열지 않는다.
- 자율 작업 목표는 계속 active다. 이 bounded capacity 작업이 제품 완성을
  대체하지 않으며 main 병합은 별도 승인 대상이다.
