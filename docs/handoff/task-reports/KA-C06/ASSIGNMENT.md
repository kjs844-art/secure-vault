# KA-C06 assignment contract

- Assigned by: user request in this session, 2026-09-30 KST.
- Worker: Codex root, cloud checkout `/workspace/secure-vault`.
- Task: 가입 메일 최소 범위 탐색 — **synthetic, local first slice**.
- Source: `codex/firstvibe-luna-release-support@e6695a086859b4c621b39505dabb44739937b077`,
  `docs/handoff/KEYATLAS_UNIVERSAL_AI_HANDOFF_AND_TODO_2026-09-24.md`, KA-C06.
- Base: `codex/firstvibe-collab-001-100-baseline@d9c66661db7d7b66f6453e94e467c424107cba66`.
- Task branch: `codex/firstvibe-ka-c06-signup-mail-discovery-20260930`.
- Checkout before work: clean; no existing KA-C06 remote branch was found.
- Completion target: `VERIFIED` for this synthetic slice; overall KA-C06 remains partial.

Allowed paths:

- `apps/web/src/features/signup-mail-discovery/**`
- `apps/web/signup-mail-discovery.html`
- `tests/fixtures/synthetic/signup-mail-discovery-v1.json`
- `contracts/local-v1/signup-mail-discovery-v1.md`
- `docs/handoff/task-reports/KA-C06/**`

Keep other tasks' UI, crypto, storage, Worker, CI, dependency declarations,
lockfiles, shared TODO, and blueprint unchanged. C04 is a separate branch and
is not a predecessor of this standalone slice. Its `mail_hint` / `needs_review`
vocabulary informs the future integration boundary.

Definition of done:

1. A frozen preview binds services, date range, metadata budget, and permission policy
   to explicit, single-use confirmation before any fixture headers are inspected.
2. Metadata-only, bounded local discovery produces reviewable service hints without
   retaining body, snippet, subject, address, message ID, links, or attachments.
3. Broad permissions, unsupported providers/versions, malformed or excessive input,
   stale confirmation, cancellation, expiry, and clock rollback fail closed.
4. Users can correct false positives; cancellation, disposal, and expiry clear the
   session's result references. No mail-provider, storage, or AI adapter is activated.
5. A standalone synthetic panel demonstrates the flow without changing shared mounts.
6. Focused regression tests, Web typecheck, and production builds pass; remaining
   provider, browser, persistence, and security-review limitations are recorded.

`REAL_SECRET_GATE=CLOSED`. File writes are authorized by the user's implementation
request. The user's follow-up request on 2026-09-30 authorizes committing and
pushing this task branch to the existing repository. Main merge, public deployment,
OAuth activation, real mailbox access, and changes to the public/shared completion
checkbox remain outside this assignment.
