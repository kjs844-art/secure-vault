# Repository Guidelines

## Project Structure & Module Organization

`crates/` contains the Rust vault, SQLite store, bridge, and WASM packages. The React/TypeScript client and mostly colocated tests are in `apps/web/src/`. `apps/android/` and `services/api/` are planning scaffolds, not deployable apps. Shared contracts, architecture/verification docs, scripts, PowerShell checks, and synthetic fixtures live in `contracts/`, `docs/`, `scripts/`, `tests/verification/`, and `tests/fixtures/synthetic/`. Do not commit generated WASM, `node_modules/`, or build output.

## Build, Test, and Development Commands

Run these from the repository root unless noted:

- `pwsh -NoProfile -NonInteractive -File .\scripts\verify-local.ps1 -Scope Workspace` runs the Secret scan first, then Rust formatting, Clippy, tests, and doctests. Omit `-Scope Workspace` for the focused VFS check.
- `pwsh -NoProfile -NonInteractive -File .\scripts\build-wasm.ps1 -SyntheticDemo` builds the required ignored demo WASM under `apps/web/src/generated/vault-wasm-demo/`; it needs Rust 1.95.0, its `wasm32-unknown-unknown` target, and the `wasm-bindgen` 0.2.128 CLI. `node scripts/test-wasm.mjs --demo` smoke-tests it.
- In `apps/web/`, run `npm ci --ignore-scripts`. Build the demo WASM first; it is not committed and is required by `npm run dev`. Use `npm test` for Vitest, `npm run typecheck` for TypeScript, and `npm run build` for the production bundle.

## Coding Style & Naming Conventions

Match `.editorconfig`: UTF-8, LF, final newline, two-space indent (four for Java/Kotlin; CRLF for PowerShell/batch). Keep React components PascalCase, TypeScript functions camelCase, and Rust modules/functions snake_case. The verifier enforces Rust formatting and warning-free Clippy.

## Testing Guidelines

Add a regression test beside changed web code (`*.test.ts`, `*.test.tsx`, or `*.wasm.test.ts`) or in the relevant Rust crate. PowerShell checks use `*.Tests.ps1`. Use only synthetic fixtures. Run focused tests while developing, then the workspace verifier and web typecheck/tests/build before review. Local passes do not replace CI or browser file-transfer evidence.

## Commit & Pull Request Guidelines

Use a focused `codex/firstvibe-<topic>` branch; never force-push or merge `main` without approval. Recent commits use short subjects such as `feat: ...`, `fix: ...`, and `docs: ...`. Stage reviewed paths explicitly, inspect `git diff --cached`, and run the Secret scan before committing. PRs should state purpose, impact, checks, and, when applicable, the related issue and UI screenshots. Follow the PR security checklist; crypto protocol changes also need an ADR, test vectors, migration plan, and external review.

## Security & Configuration

`REAL_SECRET_GATE=CLOSED`: never enter or commit real passwords, API keys, recovery codes, vault backups, logs, HAR files, or database dumps. Keep `.env.example` values blank or obvious placeholders. Report vulnerabilities privately as directed by `SECURITY.md`.
