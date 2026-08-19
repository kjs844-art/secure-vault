# Secure Vault

개발자와 AI 도구 사용자를 위한 **개인용 제로지식(Zero-Knowledge) 보안 금고이자 API 키·MCP 연결 지도**입니다.

여러 서비스의 로그인 정보, 비밀번호, API 키, Secret, MCP 연결 정보를 서비스 → 계정 → 프로젝트 → 환경 단위로 정리하고, 각 자격 증명을 어느 앱·플러그인·MCP 서버·배포 환경에 연결했는지 기록합니다. 키를 회전할 때 사용자가 기록한 모든 연결처를 갱신하도록 안내하는 것이 제품의 핵심 차별점입니다.

> 현재 단계: **합성 데이터 전용 `v0alpha1` 암호문 SQLite 영속 저장 코어**. 실제 비밀번호, API 키, 복구 키, 개인 금고 데이터는 입력·가져오기·저장하지 않습니다. 아직 사용할 수 있는 비밀번호 관리자가 아닙니다.

## 현재 검증된 범위

구현되고 자동 검증된 범위는 다음과 같습니다.

- 합성 마스터 비밀번호로 로컬 Vault Root Key 생성·래핑·잠금 해제
- 타입이 고정된 `CredentialItemV1`과 세 가지 합성 관계 fixture
- 합성 레코드의 로컬 seal/open, 버킷 패딩과 authenticated restore
- 세션을 버리고 동일한 합성 비밀번호로 다시 잠금 해제한 뒤 관계를 복구하는 흐름
- canonical CBOR만 허용하는 엄격한 payload 및 `v0alpha1` 코덱
- 비밀번호 오류, epoch·문맥 교체, 암호문 변조, 미래 버전과 비정상 인코딩 처리 테스트
- 의미 있는 평문 metadata 없이 password/record envelope를 저장하는 hardened SQLite schema
- immutable revision, expected-head CAS와 stale candidate 암호문 충돌 보존
- bounded read-only preflight 뒤 올바른 합성 비밀번호로 인증하고, 같은 process lock을 유지한 채 writable 상태로 승격하는 흐름
- DB를 닫고 다시 연 뒤 현재 head 관계를 인증·복원하는 재시작 흐름과 wrong-password 무쓰기 검증
- future schema/wire의 upgrade-required 보존, current 손상의 store-wide 읽기 전용 보존, 저장 파일 합성 marker scan
- transaction 전·후 process 종료 원자성 및 secret-bearing API compile-fail 경계

다음 기능은 **아직 구현되지 않았습니다**: 실제 자격 증명 입력·가져오기, 검색, 키 회전 workflow, recovery Key Slot, 기기 폐기·철회, 동기화, Web/Android UI, 결제, 앱스토어 출시, plugin/MCP 실행, 지원되는 backup/export와 실제 Secret 지원.

실제 자격 증명을 다루려면 rollback/누락 탐지 anchor, recovery Key Slot, hardware-backed 기기 키·생체 인증 흐름, Android 통합, sync/checkpoint, 독립 암호 검토, 침투 테스트, backup/export 복구 훈련을 모두 완료해야 합니다. 이 게이트들이 끝나기 전에는 실제 비밀번호나 API 키를 이 알파에 입력하면 안 됩니다.

## 제품 원칙

- 암호화와 복호화는 신뢰된 클라이언트에서 수행합니다.
- 서버는 금고의 평문과 의미 있는 메타데이터를 알 수 없어야 합니다.
- 운영자도 사용자의 금고 내용을 복구할 수 없습니다.
- 계정 로그인과 금고 잠금 해제는 분리합니다.
- 마스터 비밀번호와 활성화한 모든 복구 경로를 잃으면 금고는 복구할 수 없다는 사실을 숨기지 않습니다.
- 비밀번호나 Secret 충돌은 자동 덮어쓰기하지 않고 두 버전을 모두 보존합니다.

## 저장소 구조

```text
apps/android/             Kotlin Android 클라이언트
apps/web/                 React + TypeScript 웹 클라이언트
services/api/             Spring Boot 동기화·인증 API
crates/vault-crypto/      공유 Rust 암호화 코어
contracts/                버전이 지정된 암호문·동기화 계약
docs/                     제품·보안·위협 모델 문서
tests/fixtures/synthetic/ 합성 테스트 데이터 전용
```

## 이 Git 저장소·fixture·GitHub에 절대 커밋하지 않는 것

- 실제 아이디, 비밀번호, API 키, Secret, MCP 토큰
- 복구 키, 개인키, 인증서, 세션 쿠키
- 개인 금고 원본이나 암호화 백업본
- 운영 DB 덤프, 로그, HAR, 실제 계정 스크린샷

GitHub는 **소스 코드와 설계의 백업 장소**이며 사용자 금고 데이터의 백업 장소가 아닙니다. 현재 합성 전용 코어에도 실제 자격 증명을 입력하면 안 됩니다.

## 문서

- [MVP 범위](docs/MVP.md)
- [보안 아키텍처](docs/SECURITY_ARCHITECTURE.md)
- [위협 모델](docs/THREAT_MODEL.md)
- [전체 설계 명세](docs/superpowers/specs/2026-08-13-secure-vault-design.md)
- [복구·보호 수단 설계](docs/superpowers/specs/2026-08-14-recovery-protection-design.md)
- [AI 자격 증명·MCP 연결 지도 설계](docs/superpowers/specs/2026-08-14-ai-credential-relationship-design.md)
- [`v0alpha1` 합성 하네스 검증 기록](docs/verification/v0alpha1-synthetic-crypto-harness.md)
- [합성 자격 증명 로컬 코어 검증 기록](docs/verification/synthetic-credential-local-core.md)
- [암호문 SQLite 로컬 저장소](crates/vault-local-store-sqlite/README.md)
- [암호문 SQLite 로컬 저장소 검증 기록](docs/verification/ciphertext-sqlite-local-store.md)

## 개발 상태

Private GitHub 브랜치는 소스 코드 백업과 검토 표면일 뿐 사용자 금고 데이터 백업이 아닙니다. 실제 Secret을 저장하는 공개 베타는 독립 암호 설계 검토, 침투 테스트, 복구 훈련, 클라이언트 공급망 검토가 끝나기 전에는 열지 않습니다.
