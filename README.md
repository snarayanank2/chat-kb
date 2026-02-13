# chat-kb

Widget-first knowledge-base chat platform powered by Supabase, Google Drive, and OpenAI.

## Repository layout

- `owner-app/`: authenticated owner dashboard (project/source/config management)
- `widget/`: embeddable chat widget package
- `supabase/`: database migrations, Edge Functions, and local Supabase config
- `docs/`: architecture-adjacent operational and coding standards

## Phase 0 bootstrap status

- Monorepo folders created.
- Environment templates added.
- Secret inventory and handling rules documented.
- Supabase CLI local/remote setup documented.
- CI skeleton added with staged lint/test/build/deploy jobs.
- API/error/audit naming standards added.
