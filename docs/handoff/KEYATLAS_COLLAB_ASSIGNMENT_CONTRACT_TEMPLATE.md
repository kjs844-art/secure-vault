# KeyAtlas 외부 AI 단일 작업 배정 계약

이 파일은 템플릿이다. 한 AI에게 한 작업을 맡길 때 복사하여 모든 placeholder를 채운다.
빈 값이나 대괄호 placeholder가 하나라도 남으면 구현·commit·push·PR은 `NO/BLOCKED`다.

```yaml
task_number: "[NUMBER_OR_NUMBER_A]"
task_title: "[TITLE]"
mode: "[IMPLEMENT_OR_REVIEW_ONLY_OR_A_IMPLEMENT]"
assignee: "[AI_AND_SESSION]"

repository: "https://github.com/kjs844-art/secure-vault"
assigned_branch: "[EXACT_TASK_BRANCH]"
baseline_branch: "codex/firstvibe-collab-001-100-baseline"
expected_baseline_sha: "[40_HEX_SHA]"
expected_task_head_before_work: "[40_HEX_SHA]"
predecessors_verified_at_sha: "[LABEL_TO_SHA_MAP_OR_NONE]"

a_review_1: "[PATH_AND_REVIEWED_SHA_OR_NOT_APPLICABLE]"
a_review_2: "[PATH_AND_REVIEWED_SHA_OR_NOT_APPLICABLE]"
a_security_invariants: "[EXACT_INVARIANTS_OR_NOT_APPLICABLE]"
a_user_approval_reference: "[REFERENCE_OR_NOT_APPLICABLE]"
a_post_implementation_review_required: "[YES_OR_NOT_APPLICABLE]"

allowed_paths:
  - "[EXACT_FILE_OR_NEW_DIRECTORY]"
forbidden_paths:
  - ".github/**"
  - "crates/vault-crypto/**"
  - "[TASK_SPECIFIC_FORBIDDEN_PATH]"

deliverable_type: "[CODE_TEST_DOC_REVIEW]"
definition_of_done:
  - "[OBSERVABLE_RESULT]"
required_verification:
  - "[EXACT_COMMAND_OR_READ_ONLY_CHECK]"

real_secret_gate: "CLOSED"
file_write_approved: "NO"
commit_approved: "NO"
push_approved: "NO"
pr_approved: "NO"
main_merge_approved: "NO"

status: "RESERVED"
reserved_at_sha: "[40_HEX_SHA]"
final_head_sha: "UNSET"
```

추가 원칙:

- `EPIC_COORDINATION` 작업은 구현 계약으로 전환하지 않는다.
- A 작업은 서로 독립적인 검토 2건, 검토 대상 exact SHA, 보안 불변식, 사람의 명시적
  승인값이 모두 있어야만 구현 계약을 만들 수 있다.
- A 구현 결과는 구현 전 검토와 별개다. 새 final HEAD를 대상으로 서로 독립적인 검토
  2건을 다시 받고, 두 검토 모두 Critical/High/필수 UNKNOWN이 없음을 확인하기 전에는
  PR 준비 상태로 올리지 않는다.
- 허용 경로가 겹치는 활성 작업이 있거나 working tree에 기존 변경이 있으면 중단한다.
- push 승인은 오직 `origin HEAD:refs/heads/[EXACT_TASK_BRANCH]` 한 ref에만 적용된다.
- 실제 Secret·PII·`.env`·DB/WAL·backup은 입력·열람·출력하지 않는다.
