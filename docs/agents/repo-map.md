# Repo map

High-level code locations and ownership boundaries.

## Top-level layout

| Path | Purpose | Deployed as |
|------|---------|-------------|
| `owner-app/` | Authenticated owner dashboard: projects, sources, settings, Drive connect, re-sync. | Cloudflare Pages (Vite/React build → `dist/`) |
| `widget/` | Embeddable chat widget script; loads on customer sites, calls Edge Functions. | Cloudflare Pages; served as `widget.js` at site root |
| `supabase/` | Database migrations, Edge Functions, local Supabase config. | Migrations via `supabase db push`; functions via `supabase functions deploy` |
| `workers/` | Cron/scheduled workers (e.g. `ingest-cron` calling `ingest_runner`). | Cloudflare Workers |
| `docs/` | Standards, runbooks, and agent guidance. Not deployed. | — |

## Supabase boundaries

- **Migrations**: `supabase/migrations/` — schema, indexes, RLS. Apply with `supabase db push`.
- **Edge Functions**: `supabase/functions/<name>/` — e.g. `drive_connect`, `kb_resync`, `ingest_runner`, `embed_session`, `chat`. Shared code in `supabase/functions/_shared/`.
- **Secrets**: Supplied via `supabase secrets set` or dashboard; see [../secrets.md](../secrets.md).

## Frontend boundaries

- **Owner app**: React app in `owner-app/`; uses Supabase Auth and anon key; no server secrets in bundle.
- **Widget**: Standalone script in `widget/`; uses `data-api-base` and tokens from `embed_session`; no secrets.

## Workers

- **ingest-cron**: `workers/ingest-cron/` — calls `ingest_runner` on a schedule; needs `INGEST_RUNNER_URL` (and optional timeout) as Wrangler secrets.
