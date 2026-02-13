# owner-app

Owner-facing dashboard for `chat-kb`.

## Phase 2 implemented

- Supabase Auth with Google sign-in and sign-out
- Protected routes and authenticated app shell
- Project create/list/delete with handle normalization + uniqueness checks
- Project settings editor for:
  - allowed origins (exact-origin validation)
  - rate limits (rpm/burst)
  - daily/monthly request quotas
  - optional daily/monthly token quotas
  - input/output validation prompts
- Observability views:
  - source ingestion status badges and source table
  - usage summaries (daily/monthly requests and tokens)
  - audit summary filters for high-signal event types

## Local development

1. Copy `.env.example` to `.env` and set:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
2. Install dependencies:
   - `npm install`
3. Run:
   - `npm run dev`
