# KeyAtlas 현재 체크포인트

> 기준일: 2026-09-19
> 저장소: [kjs844-art/secure-vault](https://github.com/kjs844-art/secure-vault)
> 제품명: `KeyAtlas (working title)`
> 실제 비밀번호·API 키·복구 키 입력: **금지 — `REAL_SECRET_GATE=CLOSED`**

`REAL_SECRET_GATE=CLOSED`는 사용자가 나중에 켜는 제품용 kill-switch나 환경변수가
아니다. 현재 Secret scanner와 검증 스크립트가 확인하는 고정 안전 표식이다. 실제
차단은 합성 입력만 받는 닫힌 API/UI와 아래의 미해결 출시 조건으로 유지된다. 따라서
Secret scan 통과만으로 실제 Secret 입력이 허용되지는 않으며, 이를 자동으로 여는
단일 플래그도 없다. 언젠가 이 경계를 바꾸려면 코드, 독립 리뷰, 복구, VFS, 동기화,
운영 기준과 사용자 위험 승인을 모두 별도 변경으로 통과해야 한다.

이 문서는 오래된 작업 경로와 중간 테스트 수를 다시 사용하지 않도록 만든 최신
진입점이다. 최신 작업은 누적·분기된 기능 브랜치에 있고 `main`에는 합쳐지지 않았다.

## 1. 지금 한 문장으로 어디까지 왔나

KeyAtlas는 여러 서비스의 계정, 비밀번호, API 키, MCP·앱·CLI 연결처를 함께
정리하는 보안 금고다. 현재는 **합성 데이터만 쓰는 암호화 코어, 웹 데모,
IndexedDB 및 SQLite 저장 기반**까지 구현했다. 운영 로그인, 서버 동기화,
Android 생체인증, 결제와 공개 배포는 아직 연결하지 않았다.

```text
현재 검증된 합성 흐름

[React 화면]
      │ 고정된 합성 입력만 허용
      ▼
[Session / Worker]
      ▼
[Rust/WASM 보안 코어] ── 암호화·인증·변조 거부
      ▼
[IndexedDB 암호문]

별도 네이티브 흐름

[Rust 보안 코어] ── [SQLite 암호문 저장 / revision / CAS / conflict]

아직 연결하지 않은 제품 흐름

[웹 + Android] ── [복구·기기 키] ── [서버 API] ── [PostgreSQL 암호문 동기화]
                                      ├─ 서비스 로그인·패스키
                                      └─ Free/Pro 권한·결제
```

## 2. 최신 GitHub 체크포인트

| 상태 | 브랜치 | 원격 커밋 | 확인된 범위 |
|---|---|---|---|
| 완료·푸시 | `codex/firstvibe-ci-secret-scan-stability` | `b5d35ada6a9f23b615b1a05d7529c785863a789d` | 생성 산출물 스캔 안정화, PowerShell 7·5.1 회귀 각 102개 통과. 단일 8 MiB 초장문은 가용성 한계로 fail-closed한다. |
| 완료·푸시 | `codex/firstvibe-web-adapter-hardening` | `b9f3bd4f43361fb1fd610a86cdbdef6802853803` | 엄격한 잠금 boolean, 재진입 세대 검증, 대용량 exact-byte 테스트 개선. 웹 46 files / 1,467 tests, typecheck, build, 격리된 합성 Worker/WASM smoke 통과. 제품 UI 전체 브라우저 E2E는 아니다. |
| Proposed ADR 초안·푸시 | `codex/firstvibe-recovery-wire-android-adr` | `7b16aa27ddef2b1b127abfd91896fdb1f58c267c` | 복구 slot wire와 Android Keystore·생체인증 정책의 **Proposed ADR**. 구현 승인이 아니며 후보 ID/KDF를 그대로 코딩하면 안 된다. 이번 세션의 문서 정적 리뷰는 0/0/0이지만 Accepted 판정이나 독립 암호 감사가 아니다. |
| 완료·푸시 | `codex/firstvibe-sqlite-namespace-hardening` | `c1718f97055497bc608d16b0a557077a955bbf29` | Windows 모호 경로·DOS 장치명·ADS 거부, 최종 lock reparse 방어, 정확한 sidecar 이름과 dangling entry 보존. SQLite 97 passed / 0 failed / 1 ignored, Clippy·format·Secret scan 통과, 독립 리뷰 0/0/0. |

각 행의 "완료"는 그 브랜치의 제한된 작업이 검증됐다는 뜻이다. 제품 출시 완료,
실제 Secret 허용, PR 병합 또는 `main` 반영을 뜻하지 않는다.

네 SHA는 서로 독립된 네 묶음이 아니다. `b5d35ad`는 나머지의 공통 조상이고,
`b9f3bd4`는 `c1718f9`의 조상이다. 따라서 기능 통합의 실질적인 두 tip은 web·scanner를
이미 포함한 `c1718f9`와 별도 recovery ADR tip `7b16aa27`이다. 현재 `origin/main`
`ceca9f4`에는 공통 조상 이후 main 쪽 고유 commit 4개도 있으므로, 통합할 때 이것을
버리거나 덮어쓰면 안 된다.

이 문서 브랜치 `codex/firstvibe-status-guide-20260919`는 최신 웹 기준
`b9f3bd4`에서 갈라졌다. 따라서 `main` 대상의 문서-only PR로 바로 열면 안 된다.
나중에 검증된 통합 브랜치가 이 문서만 선택하거나, `origin/main`에서 새 문서 전용
브랜치를 만들어 필요한 문서 commit만 옮긴다.

최신 SQLite push의 GitHub Actions run `35435045267`은 account payment/spending-limit
차단으로 job step을 하나도 시작하지 못하고 종료됐다. 따라서 원격 테스트 성공도 코드
테스트 실패도 아니다. 로컬 검증과 독립 리뷰가 현재 증거이며, 사용자가 계정 설정을
확인하고 exact-SHA 재실행을 승인할 때까지 별도 외부 차단으로 남긴다.

## 3. 작업 폴더를 혼동하지 않는 법

상위 폴더 `C:\Users\USER\Documents\ChatGPT\KeyAtlas` 자체는 별도의 초기화된 빈 Git
저장소처럼 보이며, 실제 제품 변경의 원격 저장소가 아니다. 최신 기능 worktree는 다음과
같다.

```text
C:\Users\USER\Documents\ChatGPT\KeyAtlas\agent-staging\
├─ keyatlas-web-adapter-hardening
├─ keyatlas-ci-secret-scan-stability
├─ keyatlas-recovery-wire-android-adr
├─ keyatlas-sqlite-namespace-hardening
└─ keyatlas-status-guide-20260919
```

다른 AI는 반드시 할당받은 worktree와 브랜치에서만 작업한다. 브랜치 생성, commit,
push, PR, merge는 서로 다른 상태다. 위 네 기능 브랜치는 GitHub에 push됐지만 이 문서
작성 시점에 `main` 병합은 하지 않았다.

## 4. 완료·일부 완료·미완료 지도

| 구역 | 상태 | 설명 |
|---|---|---|
| 암호화·엄격한 codec·불변 revision | ○ | 합성 데이터 범위에서 구현·회귀 검증됨. 독립 제품 암호 감사는 별도다. |
| 웹 Worker → Rust/WASM → IndexedDB | ○ | 합성 등록·목록·검색·잠금·백업·회전 흐름과 최근 adapter hardening이 있다. |
| 네이티브 Rust → SQLite | 일부만 됨 | 재시작·CAS·충돌·원자성·최근 namespace hardening은 있다. actual-handle VFS와 전체 file-family 경계는 미완료다. |
| 복구 slot 형식 | 일부만 됨 | ADR만 Proposed 상태다. wire 확정·구현·복구 훈련이 남았다. |
| Android Keystore·생체인증 | 일부만 됨 | 정책 ADR만 있다. Kotlin 앱, hardware-backed 검증, 실기기 테스트는 없다. |
| 서비스 로그인·패스키 | × | Google/Kakao/Naver 로그인 설정과 서버 세션은 미구현이다. 로그인은 금고 복호화 키를 대신하지 않는다. |
| 서버 API·PostgreSQL 동기화 | × | 운영 서버와 DB 계정도 아직 만들지 않았다. |
| Free/Pro·결제 | × | 가격·상품·결제 사업자 결정과 구현이 남았다. |
| 공개 웹 배포·앱스토어 | × | 도메인, 운영 계정, 정책, 감사와 출시 승인이 필요하다. |
| 실제 Secret 저장 | × | 모든 출시 차단 조건을 통과하기 전까지 금지다. |

## 5. 다음 순서

```text
1. 현재 `origin/main`에서 별도 통합 브랜치를 만들고 main 고유 commit 4개를 보존한
   상태로 `c1718f9`와 recovery ADR `7b16aa27`을 조정한 뒤 전체 회귀 검증
   ↓
2. 복구 wire·Android ADR의 보안 결정을 확정
   ↓
3. 합성 데이터 전용 복구 slot과 Android skeleton 구현
   ↓
4. SQLite actual-handle VFS 또는 승인된 broker 경계 구현·권위 검증
   ↓
5. 로컬-only 서버 API·PostgreSQL schema·동기화 contract 구현
   ↓
6. 사용자가 만든 실제 클라우드/OAuth 계정을 비공개 합성 preview에 연결
   ↓
7. 독립 암호 검토·침투 테스트·복구/분실/사고 대응 훈련
   ↓
8. 제한된 실제 Secret 베타 → Free/Pro 결제 → 공개 출시·스토어 심사
```

### 사용자가 현재 작업 범위를 승인한 뒤 로컬에서 진행 가능한 일

- 사용자가 승인한 현재 작업 범위 안에서 별도 통합 브랜치 생성, 충돌 분석, 테스트와
  검증 문서 작성. commit·push·PR·`main` merge는 각각 별도 상태로 보고한다.
- Accepted 상태가 된 contract 또는 별도로 승인된 test-only 설계의 합성 구현과 테스트.
  Proposed recovery·Android ADR 자체의 제품 구현은 승인 전 시작하지 않는다.
- 로컬 PostgreSQL 대체물 또는 test container 없이 실행되는 저장 contract 테스트
- 접근성, 오류 상태, empty/loading/locked UI, 문서와 CI 정책 개선
- RED 관점 위협 모델, fuzz/property/compile-fail/원자성 회귀 강화
- 실제 키·계정을 쓰지 않는 로컬 패키징과 비공개 preview 준비

### 사용자가 결정하거나 직접 준비해야 하는 일

- 복구 방식과 "모든 복구 수단 분실 시 영구 손실" 정책 승인
- 최종 제품명·상표·도메인
- Google/Kakao/Naver, 클라우드, DB, 결제, 앱스토어 계정의 소유와 MFA
- IAM·OAuth redirect URI·billing 활성화 승인
- GitHub Actions의 payment/spending-limit 확인과 exact-SHA workflow 재실행 승인
- 통합 branch의 commit·push, PR 생성, Ready 전환과 `main` merge에 대한 단계별 승인
- Free/Pro 가격, 환불, 개인정보처리방침·이용약관
- 외부 보안 감사와 침투 테스트 범위·예산
- 실제 Secret 베타를 열지에 대한 최종 위험 승인

비밀번호, API 키, OAuth client secret, 복구 키는 채팅·GitHub issue·문서에 붙이지
않는다. 실제 연동 단계에서는 각 제공자의 비밀 저장소나 로컬 보안 입력 경로를 쓴다.

## 6. 현실적인 시간 범위

다음 추정은 **주 담당 1명 + AI 1~2개, 하루 집중 작업 4~6시간**을 가정한 임시 범위다.
사용자 의사결정, 외부 계정 심사·스토어 대기, 제3자 보안 감사 대기와 발견된 취약점의
재설계 기간은 포함하지 않는다. 1~2주 작업 뒤 실제 속도로 다시 산정하며, 보안 결함이나
심사 지연이 있으면 상한은 없다.

아래 행은 위에서 아래로 **이전 행을 마친 뒤의 누적 단계**다.

| 목표 | 조건부 예상 |
|---|---|
| 최신 브랜치 통합 + 합성 로컬 preview 안정화 | 약 1~3주 |
| 복구·Android skeleton·로컬 서버 동기화 prototype | 추가 4~8주 |
| 제한된 비공개 베타 후보 | 추가 6~12주 |
| 실제 Secret을 맡기는 공개 서비스 | 모든 보안 gate 충족이 우선. 전체 약 4~9개월 이상은 계획용 범위일 뿐이며 상한 없음 |

AI를 병렬로 쓰면 UI, 문서, 테스트와 독립된 모듈 작업은 빨라진다. 그러나 암호 설계,
복구, 저장 경계, 권한, 감사와 실제 장애 훈련은 속도보다 검증 순서를 우선한다.

## 7. 지금 유지하는 금지선

- `main` 병합, 강제 push, 공개 배포를 자동으로 하지 않는다.
- 실제 Secret, 개인정보, 복구 재료를 테스트 fixture로 쓰지 않는다.
- Proposed ADR을 확정 프로토콜처럼 구현하지 않는다.
- GitHub Actions의 0-step 실패를 코드 실패 또는 성공으로 과장하지 않는다.
- SQLite 최종 lock-entry 방어를 부모 namespace나 DB/WAL/SHM 전체 VFS 보장으로
  확대 해석하지 않는다.
- 서버가 평문을 보지 않는 목표와 브라우저 공급망·운영 메타데이터 위험을 함께
  문서화한다.
