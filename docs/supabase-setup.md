# Supabase CLI setup (local + remote)

Phase 0 baseline configuration for local development and remote project linking.

## Prerequisites

- Supabase CLI installed
- Docker running (for local Supabase stack)
- A Supabase project per environment (`dev`, `staging`, `prod`)

## Local setup

1. From repo root, ensure templates are in place:
   - `.env.example`
   - `supabase/.env.example`
2. Start local stack:
   - `supabase start`
3. Verify local services:
   - API: `http://127.0.0.1:54321`
   - Studio: `http://127.0.0.1:54323`

## Remote linking

1. Authenticate CLI:
   - `supabase login`
2. Link repository to environment project:
   - `supabase link --project-ref <PROJECT_REF>`
3. Push migrations (after Phase 1 schema exists):
   - `supabase db push`
4. Deploy functions (after implementation exists):
   - `supabase functions deploy <FUNCTION_NAME>`

## Secret provisioning (required before function deploy)

Use CLI per environment:

- `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...`
- `supabase secrets set OPENAI_API_KEY=...`
- `supabase secrets set GOOGLE_OAUTH_CLIENT_ID=...`
- `supabase secrets set GOOGLE_OAUTH_CLIENT_SECRET=...`
- `supabase secrets set TOKEN_ENCRYPTION_KEY=...`

## Branching model (recommended)

- `main` -> production deploy target
- PR branches -> CI validation only
- Optional: release branch for staged production rollout
