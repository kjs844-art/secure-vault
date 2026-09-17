# 2026-09-18 합성 키 교체 화면 검증

`REAL_SECRET_GATE=CLOSED`.

브랜치: `codex/firstvibe-rotation-ui`.
기준 커밋: `7d61e9a26e3acf5d3fe11439ea831103d7e93208`.

## 사용자가 실행할 수 있는 흐름

열린 합성 금고에서 항목 선택 → MCP/CLI/CI 연결처 확인 상태 선택 → 현재 선택 검토
→ 필수 조건 충족 확인 → 명시적 동의 → 합성 키 교체 저장까지 화면을 연결했다.
필수 연결처가 미확인이거나 마지막 데모 세대이면 저장할 수 없다. 선택이 검토 당시와
달라지거나 화면이 다시 생성되면 다시 검토해야 한다.

입력은 기존 합성 항목 reference와 고정 enum 선택뿐이다. 자유 입력이나 실제
Secret 입력은 없다. 공급자 확인 항목도 실제 확인 결과가 아닌 합성 가정임을 표시한다.
최종 제품 디자인, 실제 공급자 키 갱신/폐기 또는 서비스 출시를 뜻하지 않는다.

## 검토 결과와 저장할 선택의 결합

- `inspectRotation`은 최종 ready 알림 뒤에도 세션 generation, review version,
  open/ready 상태가 유효한 경우에만 frozen `{ reviewVersion, selection }` receipt를
  돌려준다. selection은 검증한 primitive 필드의 별도 frozen 복사본이다.
- 패널은 공개 상태의 version을 나중에 읽어 자신이 검토한 선택과 결합하지 않는다.
  해당 호출이 직접 반환한 receipt를 사용한다.
- loading/ready 알림에서 다른 검토나 잠금이 재진입하면 이전 호출은 `null`로 끝난다.
  이 두 경우를 세션 회귀 테스트로 추가했다.
- 저장 버튼은 receipt와 현재 선택의 모든 필드, 현재 review version, ready checklist,
  사용자 동의가 모두 일치할 때만 활성화된다. busy/lock에서 패널이 제거되고 다음
  generation에서 새로 생성되므로 화면 동의를 재사용하지 않는다.
- 실제 저장은 기존의 후보 사전 인증 → conflict-preserving CAS → 저장본 재읽기와
  재인증 경로를 사용한다. 이 변경은 별도 덮어쓰기나 자동 재시도를 추가하지 않는다.

## 실행한 검사

2026-09-18 재개 후 현재 파일에서 다음 명령을 직접 실행했다.

| 명령/검사 | 결과 |
|---|---|
| `npm test -- --maxWorkers=1` (`apps/web`) | 최종 exit 0, 33 files / 1169 tests passed (표시 수정 전 1168도 통과) |
| 이름 구분 수정 후 패널/세션 집중 검사 | exit 0, 2 files / 41 tests passed |
| `npm run build` (`apps/web`) | exit 0; `tsc --noEmit` 포함, 46 modules |
| 최종 빌드 산출물 | Worker 20.80 kB, WASM 407.82 kB, CSS 5.34 kB, main JS 309.50 kB |
| `pwsh -NoProfile -NonInteractive -File .\scripts\check-repository-secrets.ps1 -Root <절대 작업 경로>` | exit 0, baseline 4, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED` |
| `git diff --check` | exit 0; 문서 반영 후에도 커밋 전에 확인 |
| 기준 브랜치 `git ls-remote --heads origin refs/heads/codex/firstvibe-rotation-session-cas` | exit 0, 위 기준 SHA와 일치 |
| GitHub Actions 조회 (`gh run list`) | exit 1, HTTP 404; CLI에서 원격 CI 결과 확인 불가 |

재개 중 scanner가 상대/절대 경로 호출에서 각각 한 번
`SECRET_SCAN_FAILED setup_or_execution`과 exit 1로 끝났다. 같은 트리의 절대 경로
재검사는 통과했고, 파일을 변경하지 않는 breakpoint 진단을 붙인 실행도 통과해
오류 원인을 포착하지 못했다. 오류 상세 원문을 출력하거나 scanner 조건을 완화하지
않았다. 간헐적 실패 원인은 미확정이며 실패한 호출을 성공 증거로 사용하지 않는다.

패널은 기존 5 tests에 같은 이름의 항목을 안정적인 reference 번호로 구분하는 회귀
1개를 더해 6 tests다. 세션은 receipt 회귀를
포함해 35 tests이며, 실제 WASM+fake IndexedDB 결합 테스트도 전체 회귀에 포함된다.
앞선 집중 검사 기록은 패널+세션 40 tests, 관련 4 files/47 tests다. 아래 실제 브라우저
검사는 static markup 검사와 별도로 실행했다.

## 생성 WASM의 출처

이 worktree에서 새로 WASM을 빌드한 이전 시도는 Windows 앱 제어 오류 4551로
차단되었다. OS 정책을 변경하지 않았고, 같은 Rust 기준의 Session/CAS worktree에서
검증했던 ignored 생성 파일을 복사해 테스트했다. 이번 변경에는 Rust 소스 변경이 없다.
재개 후 파일 길이와 SHA-256을 다시 확인했다.

| 파일 (`apps/web/src/generated/vault-wasm-demo/`) | SHA-256 |
|---|---|
| `vault_client_wasm_bg.wasm` (407820 bytes) | `0C5CDAEEC8DA1E18C15BC56B38C66F055CC19ABA15CE9A50891E21D7B8E326ED` |
| `vault_client_wasm_bg.wasm.d.ts` | `955C636B1BE2C25DC8C0EE56BEE7309ABAC81919D325B36D16299B6CD3C6351F` |
| `vault_client_wasm.d.ts` | `9EDC24C71CD0E8FB77D8E17D36A04D956F408787FF271D703BE8FE32F43BD1EB` |
| `vault_client_wasm.js` | `D69B50C64A9E90D3BFAD03538325C892AF99AD46615E75F63E63AD5DA1B1543F` |

생성 파일은 Git에 포함하지 않는다. 위 검사는 현재 checkout에서 재빌드 성공이나
원격 CI 성공을 의미하지 않는다.

## 독립 검토와 남은 검증

초기 RED 리뷰에서 검토 A 완료 알림 중 검토 B가 시작될 때 A의 선택을 B의 public
version과 연결할 수 있는 Important 1건이 있었다. 위 receipt 반환 방식과 세션 회귀로
수정했다. 수정 후 리뷰 및 2026-09-18 별도 읽기 전용 리뷰 모두 Critical 0 / Important 0.
검토자는 소스와 테스트를 읽었으며 별도 브라우저 검증을 실행하지 않았다.

## 실제 브라우저 확인

이전 `agent-browser` 연결은 socket timeout 10060으로 실패했으나, 2026-09-18에는
Chrome DevTools 연결의 별도 격리 context에서 프로덕션 빌드를 실행했다.
로컬 주소 `http://127.0.0.1:4179/?view=local-vault`, 실제 Web Worker, 생성 WASM,
브라우저 IndexedDB를 사용했다. 사용자 브라우저의 기존 데이터와 외부 서비스 계정은
사용하지 않았다.

| 실행한 동작 | 관찰한 결과 |
|---|---|
| 합성 금고 생성 후 새로고침·열기 | 3개 항목 복원, 닫힌 5개 선택창과 비활성 저장 버튼 확인 |
| 같은 이름의 항목 선택 | 처음에는 3개 표시가 같음을 발견. `예시 1/2/3`을 실제 reference에 붙여 수정한 뒤 다시 빌드·열어 구분됨을 확인 |
| 예시 3 검토 후 MCP/CLI 선택 변경 | 현재 선택 재검토 안내 표시, 동의와 저장 비활성 |
| MCP는 사용자 확인, CLI는 공급자 확인 가정, CI는 미확인 후 재검토 | 현재 세대 `initial_0001`, 선택 연결처 미확인 1개. 동의하기 전 저장 불가 |
| 동의 후 저장 버튼 double-click | 목록 3개 유지, 새 패널에서 동의 초기화. 동일 항목 재검토 시 `rotated_0002`로 정확히 한 단계 전진 |
| 실제 저장본 조회 | 저장 전 3892 bytes → 저장 후 5152 bytes, 암호문 digest 변경, conflict 개수 0 |
| 새로고침 | 잠금 상태이며 키 교체 패널 제거. 재열기 후 같은 항목 재검토에서 `rotated_0002` 유지, 동의는 다시 필요 |
| 두 번째 명시적 저장 후 재검토 | `terminal_0003`, 마지막 데모 세대 안내, 동의와 추가 저장 모두 비활성 |
| 콘솔/요청 확인 | 관찰한 구간의 error/warn 0, 보존된 41개 요청은 모두 로컬 앱/Worker/WASM 파일 |

실제 IndexedDB ciphertext의 SHA-256은 첫 저장 전
`e2a4e9ef7f5a24824298391b46d260a00fc3b2aa803effe53b6f6c9b3f4cb8dd`, 첫 저장 후
`3f10afb881a1c2f1d67bc150795009c738324553060c76d97192d06df99018c3`이었다.
복호화 원문을 브라우저 진단으로 꺼내지 않았다. 기본 fixture 연결은 모두 optional이므로
required-pending 차단은 실제 브라우저 통과 항목에 포함하지 않는다.

모바일 viewport를 검증하는 도중 브라우저 연결이 재시작되어 격리 page가 사라졌다.
`list_pages`로 기존 page 부재를 확인했다. 화면 캡처의 파일 저장도 브라우저 도구의
workspace 경계에서 거부되어 PNG 산출물은 없다. 따라서 360px 화면·시각적 완성도,
전체 키보드 포커스, 멀티탭 경쟁, 오프라인·모바일 수명 주기는 여전히 미검증이다.
브라우저 성공 범위와 도구 중단 범위를 구분하며 재현되지 않은 항목을 완료로 세지 않는다.

중간 체크리스트 진행 상황은 현재 React 메모리에만 있어 잠금/새로고침 뒤 재개할 수
없다. 다음 기능은 이를 암호화하여 저장·복원하는 전체 흐름이다. 기존 완료 event와
history 규칙을 약화시키지 않는 상태 모델이 필요하다. 실제 Secret/provider proof,
rollback anchor, 복구·생체인증, 운영 계정·결제·공개 배포는 이 변경의 범위가 아니다.
