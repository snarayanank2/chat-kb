# Coding workflow

Where to implement by feature type, how to avoid drift with standards, and minimal verification.

## Where to implement

- **Owner UI, project/source/config, Drive picker**: `owner-app/` (React, Vite).
- **Embeddable chat bubble and session/chat calls**: `widget/` (widget script).
- **HTTP APIs (embed token, chat, re-sync, OAuth callback, ingestion)**: `supabase/functions/<name>/`; follow [../standards/api-contracts.md](../standards/api-contracts.md) and [../standards/error-schema.md](../standards/error-schema.md).
- **Schema, RLS, indexes**: `supabase/migrations/` (new migration files).
- **Audit events**: Use event types and metadata from [../standards/audit-events.md](../standards/audit-events.md); do not invent new event types without aligning with that taxonomy.
- **Scheduled ingest trigger**: `workers/ingest-cron/` (or add new workers under `workers/`).

## Avoiding drift with standards

- **API shape and errors**: Implement response envelope and error shape from [../standards/api-contracts.md](../standards/api-contracts.md) and [../standards/error-schema.md](../standards/error-schema.md). Link to those docs in code comments where relevant; do not copy full schema into this repo’s agent docs.
- **Audit**: Use only event types and metadata keys defined in [../standards/audit-events.md](../standards/audit-events.md). Add new types there first if needed.
- **Secrets**: No secrets in frontend or widget; server-only as in [../secrets.md](../secrets.md) and [security-secrets.md](security-secrets.md).

## Minimal change and verification

- Prefer small, focused changes: one feature area or one migration at a time.
- After edits: run the relevant build/lint/test from [testing-validation.md](testing-validation.md) for the area you changed.
- When adding an Edge Function or endpoint: ensure request/response and errors match the standards docs above.
