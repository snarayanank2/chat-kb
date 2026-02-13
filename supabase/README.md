# Supabase workspace

Contains local Supabase project state, SQL migrations, and Edge Functions.

## Structure

- `migrations/`: SQL schema and policy migrations
- `functions/drive_connect/`: Google OAuth callback function
- `functions/kb_resync/`: owner-triggered ingestion enqueue function
- `functions/ingest_runner/`: ingestion worker function
- `functions/embed_session/`: widget session token function
- `functions/chat/`: RAG chat function

## Local quick start

1. Install Supabase CLI.
2. Copy root `.env.example` to `.env` and fill local placeholders.
3. Start local stack:
   - `supabase start`
4. Serve functions locally:
   - `supabase functions serve --env-file ./supabase/.env.example`
