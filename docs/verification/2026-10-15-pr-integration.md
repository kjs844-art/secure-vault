# 2026-10-15 outstanding PR integration

This integration preserves the commit ancestry of PRs #3, #4, #5, #7, #8,
#9, #10, #11, #12, #13, #14, #16, #17, #18, #20, #21, #22, #24, and #26.
Its starting main revision is `49bd5ba71d9d0065a0b51b23f68711a529c2856e`.
It does not deploy an application or open `REAL_SECRET_GATE`.

## Conflict decisions

- #4: keep the newer CI configuration and successful verification history.
  The older branch adds no implementation beyond the current main tree.
- #10: run both release-manifest regression gates before Gallery preparation,
  retain the current benefits-web gates, and preserve both policy test groups.
- #14: retain the strict UTF-8 encoding and ordinal round-trip assertion.
- #17: preserve the integrated M03 V2 contract and tests, including snapshot
  binding and explicit confirmation. Do not replace these with the older V1.
- #18: preserve the newer browser QA runner with explicit synthetic scope,
  owned resources, deadlines, and cleanup; retain the historical QA documents.
- #21: preserve the integrated M02 walkthrough and later benefit-history
  handling, including dates, current-versus-historical labels, and empty guards.
- #24 and #26: keep both standalone routes and navigation links. Mount Identity
  Map alongside rotation and conflict panels without removing capacity or
  bridge-failure guidance.

Older handoff and evidence files describe their original commits and dates;
they are not fresh verification of this combined tree.

## Local verification

- Repository Secret scan: passed after each changed merge resolution.
- Staged whitespace checks: passed.
- Benefits-web tests with Node test concurrency 1: 1,331 passed, zero failed.
- Catalog-client focused tests: 12 passed, zero failed.
- UI foundation, provider metadata, Identity Map, and Discovery Inbox:
  12 test files and 236 tests passed with one worker.
- Landing production build and its TypeScript compilation: passed. The build
  reports an existing large-bundle warning.
- An initial parallel local test attempt exhausted process memory. Its output
  is not counted as a pass; the benefits suite was rerun sequentially above.
- Local synthetic WASM compilation stopped with `no space on device`.
  Local Rust/WASM and complete web verification are therefore not claimed.
  The combined branch must pass the Windows GitHub security workflow before
  integration into main.

The integration also applies the `source-map-js` 1.2.2 security patch to the
web and landing lockfiles. Its version, tarball URL, and SHA-512 integrity
were checked against the official npm registry. The benefits-web lockfile
already received the same patch through #33. The updated dependency must be
validated by the fresh CI install; earlier local passes used the old web and
landing installation. The workflow now builds landing before its final scan.

## Excluded PR

PR #32 at `dcfcacde57c99e1569a0fc9ace9885b7356a47a4` is not included.
Windows run `38739616983` fails all three `anchor_guard` integration tests:
missing-anchor handling, rollback preservation, and external-row deletion.
The last fixture attempts deletion through an immutable-revisions trigger.
The sidecar also needs separate review of bounded reads, path handling,
bootstrap trust, and crash consistency before its security claims can be
accepted. Do not count a successful merge of other PRs as validating it.

Security review comments that arrive after earlier PR merges remain separate
follow-up work. This record is integration evidence, not a security audit or
permission to use real passwords, provider tokens, or personal vault data.
