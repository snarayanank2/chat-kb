# Testing and validation

Practical validation commands and checklists by area. Use after making changes to confirm builds and key flows.

## Owner app

- From repo root:
  - `cd owner-app && npm ci && npm run build`
- Lint (if configured): `npm run lint` in `owner-app/`.
- Manual: run dev server, sign in, create project, set allowed origins, connect Drive, add source, trigger re-sync.

## Widget

- Build/serve the widget (see `widget/README.md` if present). Ensure `widget.js` loads and can call `embed_session` and `chat` when embedded on an allowed origin.
- Manual: embed on a test page with correct `data-api-base` and `data-project-handle`; confirm session and one chat round with citations.

## Edge Functions

- Unit tests: run any tests under `supabase/functions/_shared/` (e.g. crypto).
- Deploy and smoke-test: `supabase functions deploy <name>` then call endpoint (see main [README.md](../../README.md) “Test backend endpoints”).
- New or changed endpoints: verify response envelope and error shape per [../standards/api-contracts.md](../standards/api-contracts.md) and [../standards/error-schema.md](../standards/error-schema.md).

## Migrations

- Apply locally (with Supabase CLI and Docker): `supabase db push` from repo root (see [../supabase-setup.md](../supabase-setup.md)).
- Confirm no failed migrations and that RLS/policies match intent for owner vs service-role access.

## Ingest cron worker

- From `workers/ingest-cron/`: `npx wrangler deploy` after setting `INGEST_RUNNER_URL` (and optional timeout). Trigger manually and check Worker logs and `ingest_runner` behavior.

## Quick checklist (post-change)

1. Build the area you changed (owner-app and/or widget and/or functions).
2. If you changed an API: responses match api-contracts and error-schema.
3. If you changed schema: migrations apply cleanly and RLS is correct.
4. No secrets or sensitive values in logs, responses, or frontend/widget code ([security-secrets.md](security-secrets.md), [../secrets.md](../secrets.md)).
