# KeyAtlas 전체 설계 · 현재 위치

> **역사 스냅샷:** 이 문서는 2026-09-07 기준입니다. 현재 구현·브랜치·남은 gate는
> [2026-09-19 현재 체크포인트](CURRENT_CHECKPOINT_2026-09-19.md)를 우선합니다.
> 아래의 `웹 예정`, `UI 없음` 같은 표현을 현재 사실로 재사용하지 않습니다.

기준: 2026-09-07, 로컬 `codex/firstvibe-sqlite-store`, HEAD `f85e547` + 미커밋 변경.

**한 줄 요약: 비밀번호·API 키를 보관하는 제품의 Rust 보안 코어와 합성 데이터용 로컬 저장 기반이 있다. 사용자가 가입해서 쓰는 웹·앱·서버는 아직 없다.**

이 문서는 소스와 기존 명세를 대조한 현황 지도다. 새로운 제품 설계 승인이나 보안 인증이 아니다. 제품명은 `KeyAtlas (working title)`이다.

## 1. 사용자가 보게 될 제품

```text
서비스 → 내 계정 → 조직/프로젝트 → 개발·운영 환경
                                      ↓
                                비밀번호 / API 키
                                      ↓
                              연결된 앱 / MCP / 배포
```

위 그림은 **암호화 전 클라이언트 내부의 정보 관계**다. 서버에 이 정보를 평문 테이블로 저장한다는 뜻이 아니다. 현재 MCP 정보는 연결 내역을 기록하는 `RecordOnly` 모델이며, MCP 실행이나 API 키 자동 수집 기능은 없다. Google 로그인만으로 외부 사이트 가입 이력·비밀번호·발급 키를 전부 알아낼 수도 없다.

## 2. 목표 아키텍처 — 연결은 아직 계획

```text
┌ 사용자 기기: 잠금 해제·암호화·검색 ────────────────────┐
│ 웹 [예정]                  Android [예정]             │
│ React + TypeScript         Kotlin                     │
│ Rust/WASM 연결 [예정]       Rust 연결 + Keystore [예정] │
│ 로컬: 암호문 IndexedDB      로컬: 암호문 저장 [예정]    │
│                                                      │
│ 공유 Rust 보안 코어 [합성 구현 있음 / UI 연결 없음]    │
└────────────────────────┬─────────────────────────────┘
                         │ HTTPS 동기화 [예정]
                         │ 금고 원문 대신 암호문
                         ▼
              Spring Boot API [예정]
              로그인·기기 목록·동기화·플랜 권한
                         │
                         ▼
              PostgreSQL 서버 DB [예정]
              암호문 + 인증/운영 메타데이터
```

- **프론트**는 사람이 누르는 화면, **백엔드**는 로그인·동기화를 처리하는 서버, **DB**는 저장소다.
- 암호화는 사용자 기기에서 한다는 설계다. 서버는 마스터 비밀번호·복구 키·금고 평문을 받지 않는다.
- 서비스 로그인과 금고 잠금 해제는 별개다. Google 로그인 성공만으로 금고가 복호화되는 구조가 아니다.
- 지문은 서버에 보관하지 않고 기기에 있는 키의 사용을 승인하는 용도로 설계한다.
- 서버에 모든 정보가 숨겨지는 것은 아니다. 로그인 정보, 접속 시각/IP, 암호문 크기·불투명 ID·수정 활동 등의 메타데이터는 별도 보호 대상이다.
- 브라우저 JS 배포·공급망 위험은 남는다. 웹과 네이티브의 보안 수준이 같다고 승인된 상태가 아니다.
- 서버/DB 계정이나 외부 서비스가 전혀 없다고 단정하는 것이 아니라, **이 저장소에는 구축·연결·배포 증거가 없다**.

## 3. 현재 실제로 있는 흐름

```text
합성 테스트/예제
      ↓
vault-local-core   정보 관계·비밀 타입·레코드 처리
      ↓
vault-crypto       Argon2id / XChaCha20-Poly1305
      ↓
vault-local-store-sqlite   암호문 저장·충돌 보존
      ↓
로컬 SQLite 파일 → 종료·재실행 → 비밀번호로 잠금 해제
```

이 흐름은 테스트·합성 예제 수준이다. 사용자 웹 화면이나 모바일 앱으로 연결된 상태가 아니다.

| 영역 | 현재 상태 | 남은 핵심 |
|---|---|---|
| 웹 프론트 | `apps/web/README.md`만 있는 계획 모듈 | 화면, Rust/WASM 연결, IndexedDB, 잠금/검색 UX |
| Android | `apps/android/README.md`만 있는 계획 모듈 | Kotlin 앱, Rust 연결, Keystore·생체인증, 복구 UX |
| Rust 보안 코어 | 암호화·레코드/관계 모델 합성 구현 | 독립 검토, 복구·기기 관리, 클라이언트 통합 |
| 로컬 SQLite | 스키마·암호문 어댑터·재실행·충돌 보존 구현 | Windows 저장 경계 승인, 내보내기/복원, 롤백 방어 |
| Windows VFS | 격리된 실험용 probe | 실제 핸들 권위 검증, 정식 VFS/store 통합 |
| Spring Boot 백엔드 | `services/api/README.md`만 있는 계획 모듈 | 인증·세션·기기 목록·암호문 동기화 API |
| 서버 PostgreSQL | 설계만 있음 | 서버 스키마/마이그레이션, 운영 DB, 접근 제어·백업 |
| Google·패스키 / 복구 | 설계 단계 | 로그인과 잠금 해제 분리, 복구 Key Slots·기기 폐기 |
| 결제·공개 배포 | 미구현/미활성화 | Free/Pro 정책, 계정·도메인·운영·법률·스토어 절차 |

## 4. DB는 두 종류를 구분해야 한다

**현재 구현: 로컬 SQLite. 미래 계획: 서버 PostgreSQL. 웹 로컬 저장 계획: IndexedDB.**

로컬 SQLite의 실제 테이블:

```text
vault_state                 금고 헤더 + 감싼 Root Key 정보

heads ──────────────┐
현재 버전 포인터     ├──→ revisions    암호문 레코드의 불변 버전
conflicts ──────────┘
충돌 후보·관찰 버전 참조
```

- 레코드 내용은 암호문 envelope를 BLOB으로 저장한다. **SQLite 파일 전체를 암호화한 SQLCipher 구현은 아니다.**
- 버전·크기·불투명 ID·관계 메타데이터 등은 일부 관찰 가능하다. `password_envelope`에는 포맷 헤더와 감싼 Root Key가 포함되며 평문 마스터 비밀번호가 아니다.
- 위 네 테이블은 PostgreSQL 서버 스키마가 아니다. Android에 이 어댑터가 이미 통합됐다는 뜻도 아니다.
- GitHub는 소스/문서 백업이다. 사용자의 금고 내보내기·복원 기능을 대신하지 않는다.

## 5. 현재 보안 경계와 검증 증거

**실제 비밀번호·API 키·Secret 입력 금지: `REAL_SECRET_GATE=CLOSED`.**

2026-09-07 앞선 실행 기록에는 기본 workspace 검사 168 passed / 1 ignored, VFS feature 일반 검사 6 passed / 1 ignored, doctest 2 passed, format·Clippy exit 0이 있다. 검증 스크립트 자체 테스트는 PowerShell 5.1/7에서 각각 11개 통과했다. **이 지도 작성 요청에서 Rust 테스트를 새로 실행한 결과는 아니다.**

- 일반 검사 성공은 Phase 0A 보안 승인과 다르다. 과거 Windows 실제 핸들 판정은 `Inconclusive`이며, 이번에 `Go`로 바뀌지 않았다. 명시적 ignored gate도 재실행하지 않았다.
- 유효한 과거 DB로의 롤백/일부 누락을 탐지하는 checkpoint 기준점은 아직 없다.
- 프로세스 강제 종료 원자성 테스트는 모든 하드웨어 전원 장애의 내구성 보증이 아니다.
- 복구 수단·기기 폐기·암호문 동기화·백업/복원 훈련·독립 보안 리뷰가 더 필요하다. 테스트 개수는 완성도 %나 출시 승인 수치가 아니다.

## 6. 앞으로 할 일 — 기존 계획을 묶어서 보기

```text
지금 → ① 저장 경계 검증/승인
        → ② 복구 Key Slots·신뢰 기기 + Android 합성 흐름
        → ③ 서버 인증·암호문 동기화 + PostgreSQL
        → ④ 합성 웹 프리뷰·클라이언트 통합
        → ⑤ 독립 보안 검토·복원 훈련
        → ⑥ 승인 후 제한적 실제 Secret 베타
        → ⑦ Free/Pro·운영 준비·앱스토어/공개 출시
```

별도 승인을 받으면 ①~③과 병행해 **가짜 데이터만 있는 UI 시안**을 만들 수 있다. 이는 실제 금고 연결·실제 Secret 베타와 별개이며 이번 요청에서는 시작하지 않았다.

사용자 결정이 필요한 것: 최종 이름/도메인, 복구 정책과 실제 Secret 개방, Google/패스키 설정, 클라우드 계정·IAM, 가격·결제, 법률 문서·스토어 계정. 이번 지도 작성으로 가입·결제·배포를 진행하지 않는다.

## 7. 파일 구조와 확인 자료

```text
secure-vault-sqlite-store-design/
├─ apps/             웹·Android 계획 README
├─ services/api/     Spring Boot 계획 README
├─ crates/           현재 Rust 구현 5개
│  ├─ vault-crypto/
│  ├─ vault-local-core/
│  ├─ vault-local-store-sqlite/
│  ├─ vault-local-platform-windows/
│  └─ vault-local-sqlite-vfs-windows/
├─ contracts/        저장 형식·스키마 등 계약
├─ scripts/          로컬 검증 진입점
├─ tests/            검증 스크립트 회귀 테스트
└─ docs/             설계·계획·보안·검증 기록
```

- 작업 경로: `C:\Users\USER\Desktop\PersonalProJect\KeyAtlas\worktrees\secure-vault-sqlite-store-design`
- [기존 보안 아키텍처](SECURITY_ARCHITECTURE.md)
- [전체 제작·배포 안내서](PRODUCT_BUILD_AND_DEPLOY_GUIDE.md)
- [현재 웹 계획 모듈](../apps/web/README.md), [Android 계획 모듈](../apps/android/README.md), [서버 계획 모듈](../services/api/README.md)
- [로컬 SQLite 실제 스키마](../contracts/storage-v1/schema-v1.sql)
- [앞선 실제 검증 기록](verification/2026-09-07-local-verification-maintenance.md)

이번 변경은 이 Markdown과 바탕화면 자료 폴더의 `14_전체설계_현황지도.html`뿐이다. 제품 코드 변경·서버 실행·DB 생성·커밋·푸시·공개 배포는 하지 않았다.
