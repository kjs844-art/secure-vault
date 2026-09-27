# KeyAtlas 통합 경계 — 원본 동결 / 단일 개발 repo

2026-09-27 최신 사용자 결정. 상태: PROPOSED, 실제 코드 이식 전.
원본 benefit-validator@`954da8da0b12d55a342d187fab17abe57b93fbb0`.
대상 secure-vault@`34b43e1a5d2f1d81eb2f6456d657fd04ca57332f`.

## 구조

~~~text
읽기 전용: benefit-validator / Lovable 원본 / 기존 Cloud DB
        │ 검토한 파일만 선택적 이식, 원본으로 push/DB 쓰기 없음
        ▼
secure-vault (KeyAtlas 유일한 새 개발 repo)
  ├─ apps/benefits-web/  계획: 공개 UI·서비스/혜택·Gmail 서버 경계
  └─ apps/web/ + crates/ 현재: 금고·Worker·Rust/WASM
         ↑ 명시적 사용자 선택 + 비밀 원문 없는 참조 계약
~~~

단일 repo가 단일 DB/origin/세션/복호화 키를 뜻하지 않는다.
공개 웹과 잠금 해제된 금고는 별도 origin으로 운영하는 방향이다.
로그인 토큰을 금고 Root Key로 사용하거나 광고/외부 분석 스크립트가 있는 셸에
금고 평문을 삽입하지 않는다.

## 코드 이식 순서

1. source SHA/라이선스·저작권·모듈별 의존성을 목록화한다.
2. M01A가 apps/benefits-web의 독립 manifest/build/server 경계를 준비한다.
   현재 root의 Rust/Web 설정을 그대로 덮거나 두 React 버전을 자동으로 통일하지 않는다.
3. M02가 기존 합성 demo의 화면/데이터를 새 경로에 이식한다.
4. M04A의 검토를 반영해 로그인·메일·서버 모듈을 필요한 만큼 이식하고 합성 검증한다.
5. 사용자 승인된 별도 개발/운영 대상에서 migration·RLS·auth·삭제를 검증한다.
6. 검증된 subset만 공개한다. 실제 금고 Secret 허용은 별도다.

가져오지 않는 것: .env, 비밀값, 실제 데이터/메일/로그, DB dump, node_modules,
빌드 산출물, Lovable 연결 설정, 원본 배포 자격증명.
source 전체 디렉터리 복사나 unrelated Git histories 병합을 시작하지 않는다.
키 값이 없어도 원본 환경으로 fallback하는 URL/프로젝트 설정이 있는지 검사한다.
원본을 건드리지 않고 독립 테스트하는 것이 기본이다.

## 메일과 금고

Gmail 로그인/연결키는 서버가 복호화해 제공자 API에 접근하는 시스템이다.
운영자 접근 불가를 목표로 하는 사용자 금고와 보장이 다르다.
메일 원문 전체를 DB에 저장하지 않는다는 설명은 외부 AI 전송이 없다는 뜻이 아니다.
메일 분석 전 처리 범위·외부 전송·보관·삭제 동의와 사용자별 권한·비용을 검증한다.
AI/MCP에 금고 원문·OAuth 토큰·복구 키를 넘기지 않는다.

최소 관계 정보는 공개 서비스 slug, 불투명 참조, 관찰시각, 후보/확인상태다.
참조 ID도 개인정보일 수 있고 권한 증명이 아니다.
실제 cross-origin API/postMessage는 origin·세션·사용자 결속·회수 검토 후 구현한다.

## 기존 PR 처리

#14, #15, #5, #7~#10의 최신 SHA와 필요한 diff만 검토한다.
이번 문서 발행은 그 PR들의 merge나 두 제품의 실제 runtime 연결이 아니다.
원본 Lovable/benefit main은 동결한다. KeyAtlas main merge는 사용자 결정이 필요하다.
