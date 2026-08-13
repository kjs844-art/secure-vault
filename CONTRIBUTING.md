# Contributing

## 필수 규칙

1. 테스트에는 `tests/fixtures/synthetic/`의 합성 데이터만 사용합니다.
2. 실제 서비스와 유사한 토큰 접두사·길이도 예제에 넣지 않습니다.
3. `.env.example`에는 빈 값 또는 명백한 자리표시자만 둡니다.
4. 커밋 전 staged diff와 Secret 검사를 모두 확인합니다.
5. 암호화 프로토콜 변경은 ADR, 테스트 벡터, 마이그레이션 전략, 외부 검토 없이는 병합하지 않습니다.

## 커밋 전 점검

```powershell
git status --short
git diff --cached --name-status
git diff --cached
```

설치된 경우 다음 Secret 검사도 실행합니다.

```powershell
gitleaks dir . --redact
gitleaks git . --redact
```

`git add .` 대신 검토한 파일만 명시적으로 stage합니다.
