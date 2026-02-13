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

## 1) Prerequisites

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

## 2) Create production secrets and config values

You will need these values before deployment.

### 2.1 Required server-side secrets

- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `TOKEN_ENCRYPTION_KEY` (base64, 32-byte key for AES-256-GCM)
- `TOKEN_ENCRYPTION_KEY_VERSION` (usually `1`)
- `EMBED_TOKEN_SIGNING_SECRET` (strong random string)
- `OWNER_APP_URL` (your production owner app URL)
- `GOOGLE_OAUTH_REDIRECT_URI` (your `drive_connect` function URL)

Generate strong values:

```bash
# 32 bytes, base64 (required shape for TOKEN_ENCRYPTION_KEY)
openssl rand -base64 32

# Signing secret for embed token
openssl rand -hex 32
```

### 2.2 Required browser-safe values for owner app

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_GOOGLE_OAUTH_CLIENT_ID`
- `VITE_GOOGLE_OAUTH_REDIRECT_URI`
- `VITE_GOOGLE_PICKER_API_KEY`
- `VITE_GOOGLE_CLOUD_PROJECT_NUMBER`

## 3) Set up Supabase production project

1. Create a Supabase project in the Supabase dashboard.
2. Collect:
   - Project ref
   - `SUPABASE_URL` (`https://<project-ref>.supabase.co`)
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Log in and link this repo:

```bash
cd /Users/siva/src/chat-kb
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
```

4. Push all migrations:

```bash
supabase db push
```

5. Set function secrets (production):

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

Optional tuning controls:

```bash
supabase secrets set EMBED_TOKEN_TTL_SECONDS=300
supabase secrets set OPENAI_CHAT_MODEL=gpt-4.1-mini
supabase secrets set OPENAI_VALIDATION_MODEL=gpt-4.1-mini
supabase secrets set OPENAI_EMBEDDING_MODEL=text-embedding-3-small
supabase secrets set CHAT_RETRIEVAL_CANDIDATES=20
supabase secrets set CHAT_RETRIEVAL_FINAL=8
supabase secrets set CHAT_RETRIEVAL_MAX_PER_SOURCE=2
supabase secrets set INGEST_RUNNER_MAX_JOBS_PER_INVOCATION=1
```

6. Deploy all Edge Functions:

```bash
supabase functions deploy drive_connect
supabase functions deploy kb_resync
supabase functions deploy ingest_runner
supabase functions deploy embed_session
supabase functions deploy chat
```

## 4) Google Cloud setup (OAuth + Picker + Drive)

This app requires Google OAuth + Picker + Drive API.

### 4.1 Create/configure Google Cloud project

1. Create a Google Cloud project.
2. Save the **Project Number** (used by Picker as `VITE_GOOGLE_CLOUD_PROJECT_NUMBER`).
3. Enable APIs:
   - Google Drive API
   - Google Picker API

### 4.2 Configure OAuth consent screen

1. In Google Cloud Console, open **OAuth consent screen**.
2. Choose External (or Internal for workspace-only usage).
3. Fill required app details.
4. Add authorized domain(s) you will use in production.
5. Add scope:
   - `https://www.googleapis.com/auth/drive.file`
6. Add test users if app is not published.

### 4.3 Create OAuth 2.0 client credentials

1. Go to **Credentials** -> **Create Credentials** -> **OAuth client ID**.
2. Type: **Web application**.
3. Add authorized redirect URI:
   - `https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/drive_connect`
4. (Optional) add local redirect for development later.
5. Copy client ID and client secret.

Use these values in:

- Supabase secrets (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`)
- Owner app env (`VITE_GOOGLE_OAUTH_CLIENT_ID`, `VITE_GOOGLE_OAUTH_REDIRECT_URI`)

### 4.4 Create API key for Google Picker

1. Go to **Credentials** -> **Create Credentials** -> **API key**.
2. Restrict it to:
   - Google Picker API
   - (optionally) HTTP referrers for your owner app domain
3. Use it as `VITE_GOOGLE_PICKER_API_KEY`.

## 5) Deploy owner app to Cloudflare Pages (production)

### 5.1 Create Pages project

1. In Cloudflare dashboard, create a new Pages project for `owner-app`.
2. Connect repository and point to `owner-app` as root directory.
3. Build settings:
   - Build command: `npm ci && npm run build`
   - Build output directory: `dist`

### 5.2 Set Pages environment variables (Production)

Set these in Cloudflare Pages project settings:

- `VITE_SUPABASE_URL=https://<YOUR_PROJECT_REF>.supabase.co`
- `VITE_SUPABASE_ANON_KEY=<YOUR_SUPABASE_ANON_KEY>`
- `VITE_GOOGLE_OAUTH_CLIENT_ID=<YOUR_GOOGLE_OAUTH_CLIENT_ID>`
- `VITE_GOOGLE_OAUTH_REDIRECT_URI=https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/drive_connect`
- `VITE_GOOGLE_PICKER_API_KEY=<YOUR_PICKER_API_KEY>`
- `VITE_GOOGLE_CLOUD_PROJECT_NUMBER=<YOUR_GOOGLE_PROJECT_NUMBER>`

Deploy and note your owner app URL:

- Example: `https://owner-app.<your-pages-domain>.pages.dev`
- If using custom domain, use that in `OWNER_APP_URL` secret in Supabase.

After first owner app deploy, if URL changed, update Supabase secret:

```bash
supabase secrets set OWNER_APP_URL=https://<YOUR_OWNER_APP_DOMAIN>
supabase functions deploy drive_connect
```

## 6) Deploy widget to Cloudflare Pages (production)

Host `widget/widget.js` from a stable HTTPS URL.

### 6.1 Create Pages project for widget

Use a second Pages project with root at `widget/`.

If you want a simple static upload path, make sure the deployed artifact includes `widget.js` at site root.

Recommended resulting URL:

- `https://<WIDGET_HOST>/widget.js`

### 6.2 Embed snippet for customer sites

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

## 7) Configure project settings in owner app

In deployed owner app:

1. Sign in with Supabase Auth (Google).
2. Create a project.
3. Set allowed origins exactly (e.g. `https://example.com`).
4. Configure rate limits and quotas.
5. Connect Google Drive from settings.
6. Add sources (Docs/Slides/PDF) via Picker.
7. Trigger Re-sync for one source (this enqueues ingestion jobs).

## 8) Run `ingest_runner` in production

`kb_resync` only queues jobs. `ingest_runner` must be called to process them.

### 8.1 Manual trigger (for initial deployment validation)

```bash
curl -X POST "https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/ingest_runner"
```

### 8.2 Recommended ongoing trigger

This repo now includes a ready-to-deploy Worker at `workers/ingest-cron/`.

Files:

- `workers/ingest-cron/src/index.ts`
- `workers/ingest-cron/wrangler.toml`

What it does:

- Runs every minute via cron (`* * * * *`)
- Calls `POST https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/ingest_runner`
- Logs success/failure in Worker logs
- Exposes optional manual endpoint: `POST /trigger`

Deploy steps:

```bash
cd /Users/siva/src/chat-kb/workers/ingest-cron

# Authenticate wrangler once
npx wrangler login

# Set required worker secret/var
npx wrangler secret put INGEST_RUNNER_URL
# paste: https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/ingest_runner

# Optional: customize timeout if needed
# npx wrangler secret put INGEST_RUNNER_TIMEOUT_MS

# Deploy worker + cron trigger
npx wrangler deploy
```

After deploy, Cloudflare Cron Triggers will run `ingest_runner` automatically without manual cURL.

## 9) Production smoke test checklist (all parts)

Run these after deployment.

### 9.1 Function health checks

1. `embed_session` blocked-origin behavior:
   - Call from a non-allowed origin (or no origin) and confirm error (`blocked_origin` or `invalid_origin_format`).
2. `embed_session` allowed-origin behavior:
   - From allowed site, widget opens and obtains token.
3. `chat` behavior:
   - Send a normal question.
   - Confirm answer returns citations.
4. `kb_resync` enqueue behavior:
   - Trigger from owner app and confirm `ingest_jobs` row(s) created.
5. `ingest_runner` processing:
   - Call function and confirm source status transitions to `ready` or `failed`.
6. `drive_connect` OAuth callback:
   - Connect Drive successfully and verify `google_connections` row exists.

### 9.2 End-to-end UI test

1. Open owner app on Cloudflare Pages.
2. Create project and set `allowed_origins`.
3. Connect Google Drive.
4. Add one source and re-sync.
5. Trigger `ingest_runner`.
6. Embed widget on an allowed origin page.
7. Ask a question from source content.
8. Confirm:
   - response is generated
   - citation chip appears
   - no console/runtime errors

### 9.3 Abuse-control checks

1. Use widget from disallowed origin -> blocked.
2. Send rapid requests -> rate limit response.
3. Lower quotas and exceed them -> quota exceeded response.
4. Confirm audit events are written:
   - `embed_session_created`
   - `blocked_origin`
   - `chat_called`
   - `rate_limited` (sampled)
   - `quota_exceeded`
   - `ingestion_started`
   - `ingestion_completed` / `ingestion_failed`

## 10) Handy command reference

```bash
# Repo root
cd /Users/siva/src/chat-kb

# Link Supabase project
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>

# Push DB schema
supabase db push

# Set/update secrets
supabase secrets set KEY=value

# Deploy all functions
supabase functions deploy drive_connect
supabase functions deploy kb_resync
supabase functions deploy ingest_runner
supabase functions deploy embed_session
supabase functions deploy chat

# Trigger ingestion worker
curl -X POST "https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/ingest_runner"
```

## Notes

- Keep all real secrets out of git. Use Supabase secrets + Cloudflare env settings only.
- For this single-env setup, all steps target production directly.
- If you later add staging/dev environments, duplicate this flow per environment with isolated keys/projects.
