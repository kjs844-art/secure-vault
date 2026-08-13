# Vault Crypto Core

Rust 기반 공유 암호화 코어입니다. 키 파생·래핑, 항목 봉투, 이벤트 서명·검증, 버전 직렬화와 교차 플랫폼 테스트 벡터를 담당합니다.

## 현재 경계

`v0alpha1`은 합성 데이터로만 실험하는 비프로덕션 암호 스위트입니다. wire 계약, 후보 알고리즘과 메모리 zeroization 요구사항은 `docs/adr/0002-v0alpha1-crypto-suite.md` 및 `contracts/v0alpha1/`에 고정합니다.

- 실제 비밀번호, API 키, Secret 또는 사용자 데이터를 입력·저장하지 않습니다.
- 이 단계에서는 Web, Android, 서버 동기화, 계정과 결제를 구현하지 않습니다.
- direct `poly1305` dependency는 `poly1305/zeroize` feature unification 전용입니다. application code는 high-level XChaCha20-Poly1305 AEAD API만 사용합니다.
- 프로토콜 벡터는 독립 구현으로 재현되기 전까지 regression vector입니다.

프로덕션 알고리즘과 파라미터는 독립 보안 검토 전 확정 또는 실제 Secret 저장에 승인된 것으로 간주하지 않습니다.
