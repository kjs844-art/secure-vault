# M04A findings — Gmail / login / PII boundary

Status of evidence classes:

- CODE: present in source SHA `954da8da`
- LOCAL_VERIFY: not run in this session (no clone/exec of secret scan or `git diff --check`)
- OPS: UNKNOWN — live Supabase RLS, Lovable Cloud, Google OAuth client, and production DB were not inspected

## 1. Login vs mail-read consent vs session

| Boundary | CODE finding |
| --- | --- |
| App login | Browser `useAuth` uses Supabase Auth session (`src/hooks/useAuth.tsx`). Server functions require `Authorization: Bearer` JWT via `requireSupabaseAuth`. Token is validated with `supabase.auth.getClaims`; `userId` is `claims.sub`. |
| Mail consent | Separate OAuth through Lovable App User Connector (`google_mail`). Scopes in `GMAIL_SCOPES`: `userinfo.email`, `userinfo.profile`, `gmail.readonly`. This is mailbox-wide readonly, not a message-subset Google scope. |
| Session expiry | Middleware rejects missing/non-JWT tokens. Supabase session refresh is client-side (`autoRefreshToken` disabled on the server client). Connector reconnect is a separate 401 `credential_*` path. |
| Token storage | Google refresh tokens are not stored in-app. The app stores a Lovable `connectionAPIKey` encrypted at rest. |

Do not treat Gmail connect as the same event as KeyAtlas vault unlock.

## 2. RLS / per-user data

`email_discoveries`, `services`, `benefits`, `ai_usage` have owner RLS (`auth.uid() = user_id`) in SQL migrations. `consume_ai_quota` is `SECURITY DEFINER`, execute granted only to `service_role`.

`app_user_connections`:

- RLS enabled
- GRANT only to `service_role` (no authenticated policies)
- Reads/writes go through `supabaseAdmin` (RLS bypass) keyed by `userId` from the JWT

CODE implication: ciphertext is not readable with the anon/authenticated key **if** the live DB matches the migration. OPS confirmation of applied migrations is UNKNOWN.

Server functions that touch discoveries use the user-scoped `context.supabase` (RLS on) after auth middleware. Connection-key CRUD uses admin client by design.

## 3. Server-decryptable connection key vs client vault

`APP_USER_CONNECTION_KEY_SECRET` (32-byte base64) drives AES-256-GCM. IV (12) + tag (16) + ciphertext are stored. The server can decrypt any user's connector key if it has the env secret and service role.

This is **not** the KeyAtlas client-side vault guarantee (zero-knowledge / device keys). Transplant must keep:

- connector keys on a server that is allowed to call Gmail/Lovable
- vault secrets only in the client WASM/store

Mixing those stores would break the product threat model.

## 4. What is sent to external AI

`scanGmail`:

1. Lists up to 30 messages from the last 2 years matching a hardcoded Korean/English benefit query.
2. Fetches `format=full`, takes `text/plain` (or snippet), truncates to 3000 characters.
3. Sends subject, date, and body to Lovable AI Gateway (`https://ai.gateway.lovable.dev/v1`, model `openai/gpt-6-astra`) with `LOVABLE_API_KEY`.
4. Prompt asks the model not to echo names/addresses/payment instruments; this is instruction-only, not a technical control.
5. Persists structured rows + `evidence_subject` + SHA-256 of Gmail message id. Raw body is not stored in `email_discoveries`.
6. `providerOptions.openai.store: false`.
7. Quota: `consume_ai_quota` daily 20, shared with screenshot/text analyze.

`deleteGmailDiscoveries` deletes result rows for that user; it does not prove deletion at Lovable/OpenAI. Retention there is UNKNOWN.

Rate/cost: in-app daily 20 is CODE. Provider billing and gateway rate limits are UNKNOWN except client mapping of 429/402 in `analyzeMaterial`.

## 5. Logging and error paths

`gmailRequest` does `console.error(\`Gmail request failed [${status}]: ${body}\`)` with the full provider body. That can include mailbox fragments if the gateway echoes them. Do not ship that log line to a shared collector without redaction.

OAuth `exchangeAppUserOAuthCode` posts only `{ code }` and trusts returned `connector_id`. Binding of `code` to `app_user_id` is delegated to Lovable gateway (OPS UNKNOWN).

## 6. Default environment gravity

`.env.example` documents Lovable auto-injection of `LOVABLE_API_KEY`, `GOOGLE_MAIL_APP_USER_CONNECTOR_CLIENT_API_KEY`, and `APP_USER_CONNECTION_KEY_SECRET`, plus redirect
`https://connector-gateway.lovable.dev/api/v1/app-users/oauth2/callback`.

Transplant to KeyAtlas without rewriting connector/env will keep talking to Lovable Cloud and the original Supabase project if those URLs/keys are copied. Task forbids copying live env.

`.gitignore` does not list `.env`. At the pinned SHA a `.env` blob exists in the public repo. Treat as a source-repo incident for the owner; this review did not open the blob.

## 7. Dependencies / license (manifest only)

`package.json` name is already `keyatlas`, private package. Notable runtime: `@supabase/supabase-js`, `@lovable.dev/cloud-auth-js`, `@lovable.dev/mcp-js`, `@ai-sdk/openai`, `ai`, TanStack Start. SPDX of each lockfile package was not enumerated. Lovable packages imply a hosted-connector default.

## 8. Target (KeyAtlas) vs source

Target named SHA `34b43e1a` is a synthetic-UI-safety line, not a port of Gmail functions. There is no transplanted Gmail runtime to re-review yet. After M01A lands code, re-run this review on the new target SHA.

## Residual UNKNOWN

- Whether production/Lovable DB actually applied 0000/0001 policies
- Whether `.env` at source SHA contains live keys (blob exists; unread)
- Lovable/OpenAI retention of prompt bodies
- Google Cloud OAuth client settings (scopes actually granted, redirect allowlist)
- Session cookie vs Bearer wiring in TanStack Start browser calls (auth-attacher not fully traced)
- Local `git diff --check` / Secret scan on this docs commit (not executed here)

## Suggested isolated follow-ups (for owner, not this branch)

- Add `.env` to source `.gitignore` and rotate any values that were ever committed.
- Drop or redact `console.error` of Gmail bodies.
- Narrow query + maxResults; consider metadata-only first pass.
- Keep connector-key encryption domain separate from vault keys after transplant.
- Re-review when Gmail code exists on a KeyAtlas SHA.
