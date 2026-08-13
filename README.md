# Secure Vault

개발자와 AI 도구 사용자를 위한 **개인용 제로지식(Zero-Knowledge) 보안 금고**입니다.

여러 서비스의 로그인 정보, 비밀번호, API 키, Secret, MCP 연결 정보를 서비스 → 계정 → 프로젝트 → 환경 단위로 정리하고, Android와 웹에서 안전하게 검색·열람·복사하는 것을 목표로 합니다.

> 현재 단계: **합성 데이터 전용 `v0alpha1` 로컬 암호화 하네스**. 실제 비밀번호, API 키, 복구 키, 개인 금고 데이터는 입력·가져오기·저장하지 않습니다.

## 현재 검증된 범위

구현되고 자동 검증된 것은 다음 네 가지뿐입니다.

- 합성 마스터 비밀번호로 로컬 Vault Root Key 생성·래핑·잠금 해제
- 합성 레코드의 로컬 seal/open과 버킷 패딩
- canonical CBOR만 허용하는 엄격한 `v0alpha1` 코덱
- 비밀번호 오류, 문맥 교체, 암호문 변조와 비정상 인코딩 거부 테스트

다음 기능은 **아직 구현되지 않았습니다**: 실제 Secret 지원, 복구, 기기 폐기·철회, 영속 저장, 동기화, Web/Android UI, 결제, 앱스토어 출시, OpenAI plugin.

실제 자격 증명을 다루기 위한 다음 게이트는 **독립 암호 설계·구현 검토**와 별도의 **복구/기기 키 ADR**입니다. 두 게이트가 끝나기 전에는 실제 비밀번호나 API 키를 이 알파에 입력하면 안 됩니다.

## 제품 원칙

- 암호화와 복호화는 신뢰된 클라이언트에서 수행합니다.
- 서버는 금고의 평문과 의미 있는 메타데이터를 알 수 없어야 합니다.
- 운영자도 사용자의 금고 내용을 복구할 수 없습니다.
- 계정 로그인과 금고 잠금 해제는 분리합니다.
- 모든 복구 수단을 잃으면 금고는 복구할 수 없다는 사실을 숨기지 않습니다.
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

## 절대 저장하지 않는 것

- 실제 아이디, 비밀번호, API 키, Secret, MCP 토큰
- 복구 키, 개인키, 인증서, 세션 쿠키
- 개인 금고 원본이나 암호화 백업본
- 운영 DB 덤프, 로그, HAR, 실제 계정 스크린샷

GitHub는 **소스 코드와 설계의 백업 장소**이며 사용자 금고 데이터의 백업 장소가 아닙니다.

## 문서

- [MVP 범위](docs/MVP.md)
- [보안 아키텍처](docs/SECURITY_ARCHITECTURE.md)
- [위협 모델](docs/THREAT_MODEL.md)
- [전체 설계 명세](docs/superpowers/specs/2026-08-13-secure-vault-design.md)
- [`v0alpha1` 합성 하네스 검증 기록](docs/verification/v0alpha1-synthetic-crypto-harness.md)

## 개발 상태

Private GitHub 브랜치는 소스 코드 백업과 검토 표면일 뿐 사용자 금고 데이터 백업이 아닙니다. 실제 Secret을 저장하는 공개 베타는 독립 암호 설계 검토, 침투 테스트, 복구 훈련, 클라이언트 공급망 검토가 끝나기 전에는 열지 않습니다.
