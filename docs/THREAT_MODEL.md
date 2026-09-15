# Threat Model

## 보호 자산

- 로그인 아이디와 비밀번호
- API 키, Secret, MCP 자격 증명
- 2FA 복구 코드와 복구 키
- 서비스·계정·프로젝트 관계 및 메모
- 자격 증명의 발급 Console, 권한, 만료와 앱·플러그인·MCP 연결 지도
- 암호화 키, 기기 신뢰 목록, 동기화 이력

## 고려하는 공격자

- DB, 백업, 로그를 탈취한 공격자
- 네트워크를 관찰하거나 재전송·재정렬하는 공격자
- 서버 운영 권한을 탈취한 공격자
- 분실하거나 폐기된 기기를 가진 공격자
- 악성 브라우저 확장, XSS, 공급망 공격자
- 약하거나 재사용된 마스터 비밀번호를 추측하는 공격자
- 복구 키나 물리 보안키를 훔친 공격자, 탈취된 복구 보호자와 보호자 공모
- 한 암호화 레코드 슬롯에 여러 항목을 포장해 상품 한도를 우회하는 변조 클라이언트

## 신뢰 경계

아래 Android·서버·웹 신뢰 경계는 **목표 제품 아키텍처**를 설명합니다. 현재 합성 SQLite slice에는 Android Keystore·생체 인증, API 서버·객체 저장소, 웹 배포 클라이언트가 구현되어 있지 않습니다.

- 잠금 해제된 클라이언트 메모리는 평문을 취급하므로 신뢰 경계 안입니다.
- Android Keystore와 운영체제 생체 인증을 신뢰하되 루팅 기기의 완전한 안전은 보장하지 않습니다.
- API 서버, DB, 객체 저장소, 백업은 평문을 신뢰하지 않는 영역입니다.
- 웹 배포 서버는 매 접속 시 JavaScript를 바꿀 수 있으므로 고위험 경계로 취급합니다.

## 보안 불변조건

1. 서버 DB·백업·로그만으로 의미 있는 금고 내용과 검색어를 알아낼 수 없어야 합니다.
2. 동시 편집에서 Secret 값이 조용히 사라지면 안 됩니다.
3. 오래 오프라인이던 기기가 삭제 항목을 자동 부활시키면 안 됩니다.
4. 폐기된 기기는 새 epoch 이후 상태를 복호화하거나 유효하게 서명하면 안 됩니다.
5. 기존 신뢰 기기는 rollback, replay, 누락, 재정렬을 탐지해야 합니다.
6. 로컬 검색 인덱스를 지워도 암호화 항목에서 동일한 결과를 재구축할 수 있어야 합니다.
7. 폐기된 복구 수단과 과거 device roster가 최신 `key_epoch` 또는 `account_recovery_generation`에서 다시 유효해지면 안 됩니다.
8. 로컬 관계 인덱스를 지워도 암호화 레코드에서 같은 자격 증명 연결 지도를 재구축할 수 있어야 합니다.

## 현재 합성 SQLite slice가 구현한 방어

- 의미 있는 금고 내용과 검색용 index를 SQLite 평문 column에 저장하지 않고 canonical envelope BLOB으로 보존합니다.
- immutable revision과 expected-head CAS를 사용하며 stale candidate를 자동 덮어쓰지 않고 암호문 conflict로 보존합니다.
- 기존 DB는 bounded read-only preflight와 모든 current envelope 인증을 통과한 뒤에만, 같은 process lock을 유지하며 writable 상태로 승격합니다.
- wrong master password는 손상으로 분류하지 않고 writable connection이나 application write 없이 인증 실패로 끝냅니다.
- 더 높은 storage/wire/inner version은 upgrade-required로 원본을 보존하고, current schema·envelope·graph 손상은 store-wide 읽기 전용 보존 상태로 둡니다. 자동 repair·delete·overwrite는 하지 않습니다.
- process 종료 테스트는 revision/head/conflict transaction의 commit 전·후 가시성을 검증합니다. 임의 hardware power loss, filesystem 또는 storage hardware의 잘못된 sync 동작까지 증명하지 않습니다.

## 현재 탐지하지 못하는 rollback·누락

현재 `v0alpha1`에는 signed event/manifest, authenticated checkpoint chain 또는 OS monotonic anchor가 없습니다. 따라서 공격자가 유효한 상태를 사용해 다음을 수행하면 탐지하지 못할 수 있으며, 위 보안 불변조건 5는 아직 충족되지 않습니다.

- 과거의 정상 DB와 WAL 전체 snapshot으로 교체
- canonical head를 과거의 유효 revision으로 되돌림
- 논리 record와 그 revision row 전체를 누락

RO→RW 사이의 BLAKE3 logical digest는 같은 process의 두 단계 사이 변경만 탐지합니다. 저장·인증된 freshness proof가 아니며 rollback 또는 누락 anchor로 사용할 수 없습니다.

## 보장하지 않는 것

- 감염·루팅된 기기 또는 잠금 해제 중인 악성 브라우저에서의 평문 보호
- 사용자가 복사해 외부 앱에 붙여 넣은 이후의 보호
- 분실 기기가 과거에 이미 본 Secret의 회수
- 마스터 비밀번호와 모든 활성 복구 경로를 잃은 사용자의 운영자 복구
- 복구 보호자 정족수의 공모 또는 사용자가 기록하지 않은 외부 연결처의 자동 발견
- 독립 transparency witness가 없는 완전 신규 복구 클라이언트의 강한 targeted rollback 탐지
- 서버로부터 활성 레코드 슬롯 수, 동일 슬롯의 수정 빈도, 삭제 시각을 숨기는 것
- 서버가 암호문 안의 실제 Secret 개수나 종류를 검증하는 것

## 출시 차단 조건

rollback/누락 anchor, recovery Key Slot, hardware-backed 기기 키·생체 인증 흐름, Android 통합, sync/checkpoint, 독립 암호 설계·구현 검토, 의존성 공급망 검토, 복구·분실 기기 및 backup/export 복구 훈련, 침투 테스트, 로그 비밀정보 검사와 웹 CSP 검증을 통과하기 전에는 실제 Secret 공개 베타를 시작하지 않습니다.
