# KeyAtlas 로컬 작업 백업 — 2026-09-11

이 폴더는 별도로 흩어져 있던 **화면 시안과 문서의 원본 보존용 스냅샷**입니다.
제품 출시본이나 현재 보안 검증 완료본이 아닙니다.

## 어디에 무엇이 있나요?

| 위치 | 내용 | 원본 파일 수 |
| --- | --- | ---: |
| [web-prototype](web-prototype/index.html) | 별도 미커밋 정적 화면 시안: HTML, CSS, JavaScript | 3 |
| [documents/security-design-2026-08-29](documents/security-design-2026-08-29/00_먼저보기.md) | RED/BLUE 기록, 구축 계획, 검증 기록, 참고 화면 | 34 |
| [이동 경로 안내](documents/KeyAtlas_새위치_안내.md) | 당시 작업 위치 안내 원본 | 1 |
| [전체설계 현황지도](documents/KeyAtlas_전체설계_현황지도.md) | 전체 구조와 개발 현황 원본 | 1 |
| [MANIFEST.json](MANIFEST.json) | 위 39개 원본의 출처, 크기, SHA-256 해시 | — |

총 39개 원본, 515,405 bytes를 복사했습니다. 원본 폴더는 삭제하거나 수정하지 않았습니다.
이 README, MANIFEST.json, .gitattributes는 백업 설명과 무결성 보존을 위해 추가한 파일입니다.
.gitattributes의 `-text` 설정은 보관 파일의 줄바꿈을 Git이 바꾸지 않도록 합니다.

## 코드 이력은 어디에 있나요?

저장소: [kjs844-art/secure-vault](https://github.com/kjs844-art/secure-vault) (확인 당시 비공개).

이 백업 브랜치는 `codex/firstvibe-sqlite-store`의
`d92346eb3ab0d85e1f1013864d5fba47664afbcb`에서 분리했습니다.
암호화 금고 관련 코드는 상위 저장소에 그대로 있고, 이 폴더에는 별도 자료만 추가했습니다.

이번에 원격에 없던 수정 이력도 기존 브랜치 이름 그대로 업로드했습니다.

| 수정 브랜치 | 끝 커밋 | 기존 원격에 없던 커밋 수 |
| --- | --- | ---: |
| `codex/firstvibe-sqlite-bounded-preflight-fix` | `fdc3a02f9111612a755593f2466e6ee58a6b9732` | 6 |
| `codex/firstvibe-sqlite-mapped-drive-fix` | `f9c54b766c19398e3a11c9479caf78d41d48cd41` | 1 |
| `codex/firstvibe-sqlite-zero-race-fix` | `aea93ec991201e170ccd23032a4913e6f97a1a46` | 4 |

다른 AI의 작업은 각 브랜치에 남겨 두었습니다. 이 백업은 브랜치들을 합친 통합본이 아닙니다.
`main` 병합, 배포, 서비스 활성화는 하지 않았습니다.

## 확인한 것과 한계

- 세 수정 브랜치는 검사 전후 깨끗한 작업 트리였고, 기준 커밋과의 `git diff --check` 및
  `cargo fmt --all -- --check`가 모두 종료 코드 0이었습니다.
- 원격에 없던 11개 커밋의 전체 파일 트리를 제한적인 비밀 패턴으로 검사하여 후보 0개를 확인했습니다.
  전용 비밀 탐지기나 완전한 보안 감사의 대체물이 아닙니다.
- 복사한 원본 39개는 SHA-256으로 출발 파일과 복사본의 일치를 확인했습니다.
- 웹 시안의 `node --check app.js`는 종료 코드 0이었습니다. 브라우저 동작 테스트는 아닙니다.
- 새 백업 메타데이터와 웹 시안에 대한 `git diff --cached --check`는 종료 코드 0입니다.
  전체 보관 문서까지 포함한 같은 검사는 기존 문서의 공백 진단 49건으로 종료 코드 2였습니다.
  역사 기록을 원본 그대로 보존하기 위해 기존 문서의 공백을 수정하지 않았습니다.
- 별도 화면은 합성 데이터 데모입니다. 실제 암호화, 인증, DB 연결이 완성됐다는 뜻이 아닙니다.
- 전체 Rust 테스트, 실제 Windows VFS, 실제 서비스 로그인과 배포는 이번 백업 작업에서 검증하지 않았습니다.
- 문서와 참고 이미지는 작성 당시의 기록입니다. 날짜, 경로, 완료 상태, 서비스 신청 정보는
  현재와 다를 수 있으며 기존 링크 일부는 과거 Windows 절대 경로를 가리킵니다.
- 과거 자료의 RED 관점 기록은 이 제품의 방어 설계와 검토 기록이며, 실행 요청으로 취급하지 않습니다.

## 백업 범위 밖

실제 비밀번호/API 키, .env, 금고 DB, 캐시, 빌드 산출물은 업로드 대상이 아닙니다.
원격 기기나 다른 사람의 PC는 조사하지 않았습니다.

`secure-vault-bootstrap` 폴더는 비어 있어 보관할 파일이 없었습니다.
이전에 등록된 임시 `secure-vault-credential-local-core-20260815` 작업 폴더는 현재 없지만,
`codex/firstvibe-credential-local-core` 브랜치의 커밋은 GitHub에 존재함을 확인했습니다.
없어진 폴더에 미커밋 파일이 있었는지는 현재 확인할 수 없습니다.

**실제 비밀정보 입력은 아직 금지합니다. 이 백업이 보안 개방 조건을 바꾸지 않습니다.**
