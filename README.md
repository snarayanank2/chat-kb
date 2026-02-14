# chat-kb

Widget-first knowledge-base chat platform powered by Supabase, Google Drive, and OpenAI.

This README is a production deployment runbook for all app parts using:

- Supabase (database + Edge Functions)
- Cloudflare Pages (owner app + widget script hosting)
- Google Cloud (OAuth + Picker + Drive APIs)
- OpenAI (embeddings, chat, validation, PDF fallback extraction)

## Repository layout

- `owner-app/`: authenticated owner dashboard (project/source/config management)
- `widget/`: embeddable chat widget package (`widget.js`)
- `supabase/`: database migrations, Edge Functions, and local Supabase config
- `docs/`: architecture-adjacent operational and coding standards

## What gets deployed

- **Database schema**: SQL migrations in `supabase/migrations`
- **Edge Functions**:
  - `drive_connect`
  - `kb_resync`
  - `ingest_runner`
  - `embed_session`
  - `chat`
- **Frontend (owner app)**: built from `owner-app/` and hosted on Cloudflare Pages
- **Widget script**: `widget/widget.js` hosted on Cloudflare Pages

## Prerequisites

- Node.js 22+
- npm
- Supabase CLI (latest)
- Cloudflare account (Pages enabled)
- Google Cloud project (billing enabled if required by your org)
- OpenAI API key

Install Supabase CLI (if missing):

```bash
brew install supabase/tap/supabase
```

Verify:

```bash
supabase --version
node --version
npm --version
```

---

## 1) Create / configure Google Cloud project

This app requires Google OAuth + Picker + Drive API. Do this first so you have client ID, client secret, project number, and Picker API key for later steps.

### 1.1 Create and configure the project

1. Create a Google Cloud project.
2. Save the **Project Number** (used by Picker as `VITE_GOOGLE_CLOUD_PROJECT_NUMBER`).
3. Enable APIs:
   - Google Drive API
   - Google Picker API

### 1.2 Configure OAuth consent screen

1. In Google Cloud Console, open **OAuth consent screen**.
2. Choose External (or Internal for workspace-only usage).
3. Fill required app details.
4. Add authorized domain(s) you will use in production.
5. Add scope:
   - `https://www.googleapis.com/auth/drive.file`
6. Add test users if app is not published.

### 1.3 Create OAuth 2.0 client credentials

1. Go to **Credentials** -> **Create Credentials** -> **OAuth client ID**.
2. Type: **Web application**.
3. Add authorized redirect URI (you will use your Supabase `drive_connect` URL once you have a project ref):
   - `https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/drive_connect`
4. (Optional) add local redirect for development later.
5. Copy **client ID** and **client secret**.

These are used later as `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` (Supabase), and `VITE_GOOGLE_OAUTH_CLIENT_ID` / `VITE_GOOGLE_OAUTH_REDIRECT_URI` (owner app).

### 1.4 Create API key for Google Picker

1. Go to **Credentials** -> **Create Credentials** -> **API key**.
2. Restrict it to:
   - Google Picker API
   - (optionally) HTTP referrers for your owner app domain
3. Save it for use as `VITE_GOOGLE_PICKER_API_KEY`.

**Outputs for next steps:** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `VITE_GOOGLE_CLOUD_PROJECT_NUMBER`, `VITE_GOOGLE_PICKER_API_KEY`. Redirect URI will be set once you have your Supabase project ref.

---

## 2) Create / configure / link Supabase project

1. Create a Supabase project in the [Supabase dashboard](https://supabase.com/dashboard).
2. Collect:
   - **Project ref** (from project URL or settings)
   - `SUPABASE_URL` → `https://<project-ref>.supabase.co`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Log in and link this repo:

```bash
cd /path/to/chat-kb
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
```

4. Push all migrations:

```bash
supabase db push
```

**Outputs for next steps:** Project ref, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Use the project ref to form `GOOGLE_OAUTH_REDIRECT_URI` = `https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/drive_connect` in Google OAuth client and in secrets below.

---

## 3) Create / prepare Cloudflare project(s)

Create and configure the Cloudflare projects so they are ready for deployment once backend and secrets are in place.

### 3.1 Owner app (Cloudflare Pages)

1. In Cloudflare dashboard, create a new **Pages** project for the owner app.
2. Connect the repository and set **Root directory** to `owner-app`.
3. Build settings:
   - Build command: `npm ci && npm run build`
   - Build output directory: `dist`
4. Do not deploy yet; environment variables will be set in step 7 before first deploy.

### 3.2 Widget (Cloudflare Pages)

1. Create a second Pages project for the widget.
2. Set root to `widget/`.
3. Ensure the deployed artifact serves `widget.js` at site root so the URL is `https://<WIDGET_HOST>/widget.js`.

**Outputs for next steps:** Owner app project and widget project exist. You will get the owner app URL after first deploy in step 7 and use it in `OWNER_APP_URL` and optionally update Supabase secret + redeploy `drive_connect` if needed.

---

## 4) Gather and set all Supabase secrets

Gather or generate every value below, then set them so Edge Functions can be deployed and run.

### 4.1 Generate values you need to create

```bash
# 32 bytes, base64 (required shape for TOKEN_ENCRYPTION_KEY)
openssl rand -base64 32

# Signing secret for embed token
openssl rand -hex 32
```

### 4.2 Required server-side secrets (Supabase function secrets)

Set these with `supabase secrets set ...` (or in Supabase dashboard):

- `SUPABASE_URL` = `https://<YOUR_PROJECT_REF>.supabase.co`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_OAUTH_CLIENT_ID` (from step 1)
- `GOOGLE_OAUTH_CLIENT_SECRET` (from step 1)
- `TOKEN_ENCRYPTION_KEY` (base64 32-byte key from 4.1)
- `TOKEN_ENCRYPTION_KEY_VERSION` = `1`
- `EMBED_TOKEN_SIGNING_SECRET` (from 4.1)
- `OWNER_APP_URL` = your production owner app URL (e.g. `https://owner-app.<pages-domain>.pages.dev` — use a placeholder if not deployed yet, then update after step 7)
- `GOOGLE_OAUTH_REDIRECT_URI` = `https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/drive_connect`

Example:

```bash
supabase secrets set SUPABASE_URL=https://<YOUR_PROJECT_REF>.supabase.co
supabase secrets set SUPABASE_ANON_KEY=<YOUR_SUPABASE_ANON_KEY>
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<YOUR_SUPABASE_SERVICE_ROLE_KEY>
supabase secrets set OPENAI_API_KEY=<YOUR_OPENAI_API_KEY>
supabase secrets set GOOGLE_OAUTH_CLIENT_ID=<YOUR_GOOGLE_OAUTH_CLIENT_ID>
supabase secrets set GOOGLE_OAUTH_CLIENT_SECRET=<YOUR_GOOGLE_OAUTH_CLIENT_SECRET>
supabase secrets set TOKEN_ENCRYPTION_KEY=<BASE64_32_BYTE_KEY>
supabase secrets set TOKEN_ENCRYPTION_KEY_VERSION=1
supabase secrets set EMBED_TOKEN_SIGNING_SECRET=<LONG_RANDOM_SECRET>
supabase secrets set OWNER_APP_URL=https://<YOUR_OWNER_APP_DOMAIN>
supabase secrets set GOOGLE_OAUTH_REDIRECT_URI=https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/drive_connect
```

Optional tuning:

```bash
supabase secrets set EMBED_TOKEN_TTL_SECONDS=300
supabase secrets set OPENAI_CHAT_MODEL=gpt-5-mini
supabase secrets set OPENAI_VALIDATION_MODEL=gpt-5-mini
supabase secrets set OPENAI_EMBEDDING_MODEL=text-embedding-3-small
supabase secrets set CHAT_RETRIEVAL_CANDIDATES=20
supabase secrets set CHAT_RETRIEVAL_FINAL=8
supabase secrets set CHAT_RETRIEVAL_MAX_PER_SOURCE=2
supabase secrets set INGEST_RUNNER_MAX_JOBS_PER_INVOCATION=1
```

### 4.3 Browser-safe values for owner app (used in step 7)

These are set in Cloudflare Pages environment variables when you deploy the owner app:

- `VITE_SUPABASE_URL` = `https://<YOUR_PROJECT_REF>.supabase.co`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_GOOGLE_OAUTH_CLIENT_ID`
- `VITE_GOOGLE_OAUTH_REDIRECT_URI` = `https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/drive_connect`
- `VITE_GOOGLE_PICKER_API_KEY`
- `VITE_GOOGLE_CLOUD_PROJECT_NUMBER`

**Outputs for next steps:** All Supabase function secrets are set. Backend can be deployed and tested.

---

## 5) Deploy backend code to Supabase

Deploy all Edge Functions:

```bash
cd /path/to/chat-kb
supabase functions deploy drive_connect
supabase functions deploy kb_resync
supabase functions deploy ingest_runner
supabase functions deploy embed_session
supabase functions deploy chat
```

**Outputs for next steps:** All functions are live at `https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/<name>`. Proceed to backend tests.

---

## 6) Test backend endpoints

Confirm each function behaves as expected before relying on them from the owner app or widget.

1. **`embed_session` — blocked origin**
   - Call from a non-allowed origin (or no origin) and confirm error (`blocked_origin` or `invalid_origin_format`).
2. **`embed_session` — allowed origin**
   - From an allowed site, widget should open and obtain a token.
3. **`chat`**
   - Send a normal question; confirm the response includes citations.
4. **`kb_resync`**
   - Trigger from owner app (after step 8) or via allowed flow; confirm `ingest_jobs` row(s) are created.
5. **`ingest_runner`**
   - Call the function (step 9) and confirm source status transitions to `ready` or `failed`.
6. **`drive_connect`**
   - Complete OAuth from owner app and verify a `google_connections` row exists.

Fix any failures before deploying the owner app.

---

## 7) Deploy owner app to Cloudflare

1. In the owner app Pages project (created in step 3), set **Production** environment variables:
   - `VITE_SUPABASE_URL=https://<YOUR_PROJECT_REF>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY=<YOUR_SUPABASE_ANON_KEY>`
   - `VITE_GOOGLE_OAUTH_CLIENT_ID=<YOUR_GOOGLE_OAUTH_CLIENT_ID>`
   - `VITE_GOOGLE_OAUTH_REDIRECT_URI=https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/drive_connect`
   - `VITE_GOOGLE_PICKER_API_KEY=<YOUR_PICKER_API_KEY>`
   - `VITE_GOOGLE_CLOUD_PROJECT_NUMBER=<YOUR_GOOGLE_PROJECT_NUMBER>`
2. Deploy (trigger build or push to connected branch).
3. Note the owner app URL (e.g. `https://owner-app.<your-pages-domain>.pages.dev` or custom domain).

If this URL was not set (or was a placeholder) in step 4, update Supabase and redeploy `drive_connect`:

```bash
supabase secrets set OWNER_APP_URL=https://<YOUR_OWNER_APP_DOMAIN>
supabase functions deploy drive_connect
```

**Outputs for next steps:** Owner app is live. Use it to create projects, set allowed origins, connect Drive, add sources, and trigger re-sync.

---

## 8) Test owner app

In the deployed owner app:

1. Sign in with Supabase Auth (Google).
2. Create a project and set **allowed origins** (e.g. `https://example.com`).
3. Configure rate limits and quotas.
4. Connect Google Drive from settings.
5. Add at least one source (Docs/Slides/PDF) via Picker.
6. Trigger **Re-sync** for that source so ingestion jobs are enqueued.

Confirm no console or runtime errors and that Drive connection and source creation succeed. Proceed to manual ingest run.

---

## 9) Run ingest runner manually and verify logs

`kb_resync` only enqueues jobs. `ingest_runner` must be invoked to process them.

Trigger once manually:

```bash
curl -X POST "https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/ingest_runner"
```

Verify:

- Response indicates success or structured error.
- In Supabase (e.g. Studio or logs): check Edge Function logs for `ingest_runner`; confirm jobs are processed and source status moves to `ready` or `failed`.
- Optionally inspect `ingest_jobs` and related tables for expected updates.

Only after this works, deploy the cron worker in step 10.

---

## 10) Deploy ingest runner to Cloudflare Worker

This repo includes a Worker that calls `ingest_runner` on a schedule so you do not need to run cURL manually.

Location: `workers/ingest-cron/` (`src/index.ts`, `wrangler.toml`).

Behavior:

- Runs every minute via cron (`* * * * *`).
- Calls `POST https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/ingest_runner`.
- Logs success/failure in Cloudflare Worker logs.
- Optional manual trigger: `POST /trigger` on the worker URL.

Deploy:

```bash
cd /path/to/chat-kb/workers/ingest-cron
npx wrangler login
npx wrangler secret put INGEST_RUNNER_URL
# Enter: https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/ingest_runner
# Optional: npx wrangler secret put INGEST_RUNNER_TIMEOUT_MS
npx wrangler deploy
```

After deploy, Cron Triggers will run `ingest_runner` automatically.

---

## 11) Test that everything is working end to end

Full system check:

1. Open the owner app on Cloudflare Pages.
2. Create a project (if needed) and set `allowed_origins`.
3. Connect Google Drive and add one source; trigger Re-sync.
4. Wait for `ingest_runner` (cron or manual) to process the job; confirm source becomes `ready`.
5. Embed the widget on an allowed origin page:

```html
<script
  src="https://<WIDGET_HOST>/widget.js"
  data-project-handle="my-project-handle"
  data-api-base="https://<YOUR_PROJECT_REF>.supabase.co/functions/v1"
  data-position="right"
  data-primary-color="#2563eb"
  data-title="Docs Assistant"
  data-welcome-text="Ask anything about our docs."
></script>
```

6. Ask a question that should be answered from the source content.
7. Confirm:
   - A response is generated with citations.
   - Citation chips appear.
   - No console or runtime errors.

Abuse-control checks (optional):

- Use the widget from a disallowed origin → request should be blocked.
- Send rapid requests → rate limit response.
- Exceed quotas → quota exceeded response.
- Confirm audit events (e.g. `embed_session_created`, `blocked_origin`, `chat_called`, `rate_limited`, `quota_exceeded`, `ingestion_started`, `ingestion_completed` / `ingestion_failed`) where applicable.

---

## Handy command reference

Order matches the runbook. Run from repo root unless noted.

```bash
# 1–2: Google Cloud (console); then Supabase link + DB
cd /path/to/chat-kb
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
supabase db push

# 4: Set/update secrets
supabase secrets set KEY=value

# 5: Deploy all functions
supabase functions deploy drive_connect
supabase functions deploy kb_resync
supabase functions deploy ingest_runner
supabase functions deploy embed_session
supabase functions deploy chat

# 9: Manual ingest trigger
curl -X POST "https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/ingest_runner"

# 10: Ingest cron worker (from workers/ingest-cron)
cd workers/ingest-cron
npx wrangler login
npx wrangler secret put INGEST_RUNNER_URL
npx wrangler deploy
```

---

## Notes

- Keep all real secrets out of git. Use Supabase secrets and Cloudflare env settings only.
- This runbook targets a single production environment. For staging/dev, repeat the flow with separate projects and keys.
- See `docs/secrets.md` for secret inventory and rotation; see `docs/supabase-setup.md` for local Supabase and linking.
