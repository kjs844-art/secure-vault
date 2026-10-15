# KA-BASE-01 canonical exact-SHA local regression report

## Decision

```text
TASK_STATE=BLOCKED
BLOCKER=LOCAL_DISK_SPACE
COMPLETION_TARGET=FULL_LOCAL_REGRESSION_RECORDED
COMPLETION_TARGET_MET=NO
ASSIGNMENT_CONTRACT_STATUS=NOT_PREDECLARED
REAL_SECRET_GATE=CLOSED
```

This report is a partial, fail-closed checkpoint. It does not claim a complete
workspace regression, remote CI success, PR creation, integration, or merge.
The shared board still listed `KA-BASE-01` as `WAITING_ASSIGNMENT` when this
read-only regression attempt began, so this report does not retroactively imply
that a complete assignment contract had been approved.

## Fixed scope

- Date: 2026-09-25 (Asia/Seoul)
- Source branch: `codex/firstvibe-collab-001-100-baseline`
- Exact source SHA: `d9c66661db7d7b66f6453e94e467c424107cba66`
- Task branch: `codex/firstvibe-base-regression-20260925-01`
- Worktree: `C:\Users\USER\Documents\ChatGPT\KeyAtlas\agent-staging\keyatlas-base-regression-20260925-01`
- Product-code changes: none
- Git state before commit: the task report is the only staged path; no other
  tracked or untracked change is present
- Dependency installation: none
- Actual Secret use: none
- Commit / push / PR / merge / `main` / deployment: not run

Before the task branch was created, the canonical worktree was clean and its
local HEAD equaled its upstream at the exact source SHA above. The task branch
started from that SHA.

## Executed checks

| Order | Command / stage | Exit | Result |
|---:|---|---:|---|
| 1 | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\check-repository-secrets.ps1 -Root .` | 0 | `SECRET_SCAN_BASELINE_ALLOWED=4`, exactly one `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED` |
| 2 | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\verify-local.ps1 -Scope Workspace` | 1 | Aggregate failure at `default-tests`; earlier stages are recorded separately below |
| 2a | repository Secret scan inside `verify-local.ps1` | 0 | PASS |
| 2b | `cargo fmt --all -- --check` | 0 | PASS |
| 2c | workspace Clippy, offline and locked, all targets/features, warnings denied | 0 | PASS |
| 2d | workspace default tests, offline and locked, one test thread | 101 | BLOCKED: Windows error 112 / `no space on device` while Rust metadata was written |
| 3 | post-report repository Secret scan (not a post-build scan) | 0 | `SECRET_SCAN_BASELINE_ALLOWED=4`, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED` |

The failure is an environment-capacity failure, not evidence that the tests
passed or that product code failed an assertion.

## Not run because the fail-closed verifier stopped

- `probe-ordinary-tests`
- workspace doctests
- default release WASM build and smoke test
- synthetic-demo release WASM build and smoke test
- Web unit tests, typecheck, and build
- post-build repository Secret scan

Every item above remains `NOT_RUN`, not `PASS`.

## Independent report review

- Pre-commit read-only review found P1 0.
- The reviewer found state-enum, assignment-contract, Git-state, and cleanup
  transparency issues in the first report draft. Those findings were corrected
  before commit.
- Review of this report is documentation evidence only; it does not replace any
  unexecuted Rust, WASM, Web, or remote CI check.

## Disk evidence and preservation decision

- C: available space after the failure was approximately 8 MB and later
  reached 0 bytes before cleanup.
- Ignored task-local `target` directory: 1,891 files, 424,767,901 bytes
  (approximately 0.396 GiB).
- `git check-ignore -v target` matched `.gitignore:58` (`**/target/`).
- The exact task-local `target` was verified as a regular, non-reparse
  directory; no `cargo` or `rustc` process was running.
- Only that rebuildable directory, created by this regression run, was removed
  after the drive reached 0 bytes. No source, report, dependency cache, or
  another worktree was removed.
- The removal bypassed the Recycle Bin and was permanent. Recovery is only by
  regenerating the ignored build artifacts from source.
- Available C: space immediately after that bounded cleanup was 382,906,368
  bytes (approximately 0.357 GiB), still insufficient to rerun the full build.
- A separate read-only inventory was requested before any additional cleanup
  decision.
- That inventory found 39 remaining ignored generated directories totaling
  27.490 GiB; 17 `target` directories account for 26.628 GiB. No additional
  path was deleted, moved, compressed, or edited. Any further cleanup requires
  a separate active-worktree check and explicit approval.

## Resume gate

1. Define and approve a complete `KA-BASE-01` assignment contract.
2. Obtain explicit approval for any additional bounded cleanup of reproducible
   build artifacts, or provide another verified volume with sufficient free
   space.
3. Reconfirm the exact source SHA and clean tracked state.
4. Rerun the repository Secret scan first.
5. Rerun the complete Workspace verifier from the beginning.
6. Only after it passes, run both WASM variants, Web checks, a post-build Secret
   scan, and an independent read-only review.

Until all six resume steps have recorded evidence, `KA-BASE-01` stays
unchecked.
