# Vault Crypto Core

Rust 기반 공유 암호화 코어 후보입니다. 장기적으로 키 파생·래핑, 항목 봉투와 버전 직렬화를 담당하도록 설계하지만, 현재 구현 범위는 아래의 합성 전용 `v0alpha1` 하네스뿐입니다.

## 현재 경계

`v0alpha1`은 합성 데이터로만 실험하는 비프로덕션 암호 스위트입니다. wire 계약, 후보 알고리즘과 메모리 zeroization 요구사항은 `docs/adr/0002-v0alpha1-crypto-suite.md` 및 `contracts/v0alpha1/`에 고정합니다.

- 구현·검증됨: 합성 비밀번호 기반 로컬 root-key wrap/unlock, 합성 레코드 seal/open, 엄격한 canonical `v0alpha1` 코덱, mutation rejection 테스트.
- 미구현: 실제 Secret 지원, 복구, 기기 폐기·철회, 영속 저장, 동기화, Web/Android UI, 결제, 스토어 출시, OpenAI plugin.
- 금지: 실제 비밀번호, API 키, Secret, 복구 코드 또는 사용자 데이터를 입력·가져오기·저장하지 않습니다.
- direct `poly1305` dependency는 `poly1305/zeroize` feature unification 전용입니다. application code는 high-level XChaCha20-Poly1305 AEAD API만 사용합니다.
- 프로토콜 벡터는 독립 구현으로 재현되기 전까지 regression vector입니다.

다음 게이트는 독립 암호 설계·구현 검토와 별도의 복구/기기 키 ADR입니다. 프로덕션 알고리즘과 파라미터는 이 게이트 전에는 확정되거나 실제 Secret 저장에 승인된 것으로 간주하지 않습니다.
