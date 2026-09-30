# KA-C02 assignment contract

- task_id: `KA-C02`
- assigned_by: user chat 2026-09-30
- worker: Grok session
- task_branch: `codex/firstvibe-ka-c02-identity-map-20260930`
- base_branch / SHA: `codex/firstvibe-local-session-hardening@ce518ee71c203dc7cb70b7c448a9338cd3129ebb`
- allowed paths:
  - `apps/web/src/features/identity-map/**`
  - `apps/web/src/App.tsx`
  - `apps/web/src/main.tsx`
  - `apps/web/src/features/local-vault/LocalVaultPanel.tsx`
  - `docs/handoff/task-reports/KA-C02/**`
- forbidden: crypto/storage/worker/CI, C03–C06 discovery/import/mail, `main` merge, real secrets
- REAL_SECRET_GATE: `CLOSED`
- completion_target this slice: `DRAFT_PR` first product explorer, not full 2–4 week UX
