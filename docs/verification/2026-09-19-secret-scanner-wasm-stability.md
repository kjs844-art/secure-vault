# Generated WASM Secret Scanner Stability

## Scope

This checkpoint hardens the repository Secret scanner against nondeterministic
regular-expression timeouts after the web build. It does not open the product
to real passwords, API keys, tokens, or other Secret material.

`REAL_SECRET_GATE=CLOSED` remains the controlling product boundary.

## Observed failure

The same source revision, `b05ff454029676947d8f6c515acf488b3b787d29`,
produced different GitHub Actions outcomes:

- run `35313800938` passed Rust, WASM, 1,449 web tests, type checking, and the
  web build, then failed during the post-build Secret scan;
- run `35330880059` completed the full workflow successfully.

A read-only diagnostic run exposed a `RegexMatchTimeoutException` while the
scanner evaluated the generated `apps/web/dist/*.wasm` ASCII projection. The
projection was 1,457,712 characters long. No actual Secret finding was shown;
the fail-closed scanner terminated because one complex regular-expression
evaluation exceeded its two-second timeout.

## Change

The supported detection expressions and their two-second timeout are retained.
Before invoking those expressions, the scanner now divides input into bounded,
newline-aligned candidate batches. It locates broad public anchor terms with
invariant, case-insensitive string search and evaluates only batches containing
an anchor. Candidate batches target 8 KiB and may extend only to the end of the
current line.

This preserves the existing detection language because every supported finding
shape contains at least one configured anchor, invariant comparison is a
conservative prefilter for the detection regex case folding on both supported
PowerShell engines, and the existing finding shapes cannot span a newline.
Generated binary projections are still scanned, config rules remain disabled
for binary projections, and any scanner exception remains a failure.

The regression suite now includes a 512 KiB WASM-like binary that:

- contains benign credential-related metadata and must finish successfully;
- then contains a constructed synthetic provider-token shape and must fail;
- reports only the safe relative file path, never the detected value.

Additional regressions cover an anchor-dense binary projection under a reduced
cooperative time budget and the engine-specific invariant Unicode case-fold
behavior. They prevent the prefilter from reintroducing quadratic work or
silently weakening the existing regex language.

The existing catastrophic-regex regression was also moved behind an anchor so
it continues to prove that a regular-expression timeout fails closed after the
new prefilter.

## Local verification

All test data was synthetic.

- PowerShell 7 scanner regressions: exit `0`,
  `SECRET_SCANNER_TESTS_PASSED=102`.
- Windows PowerShell 5.1 scanner regressions: exit `0`,
  `SECRET_SCANNER_TESTS_PASSED=102`.
- Scan of this worktree: exit `0`, `SECRET_SCAN_PASSED`,
  `REAL_SECRET_GATE=CLOSED`.
- Scan of the existing built `b05ff454` worktree, including its generated
  WASM: exit `0`, `SECRET_SCAN_PASSED`, `REAL_SECRET_GATE=CLOSED`.
- Four concurrent scans of that built worktree: all four exited `0` with the
  same pass and closed-gate markers.

## Remaining limits

- Local evidence does not replace an exact-revision GitHub Actions run. The
  branch must be pushed and its complete remote workflow must pass before this
  checkpoint is treated as remotely verified.
- If a future detection expression introduces a new finding shape without one
  of the configured anchors, the anchor list and regression suite must be
  updated in the same change.
- This scanner reduces accidental repository exposure. It is not authorization
  to store real Secret material, and it is not a substitute for production key
  management, independent security review, or incident response.
