# ingest_runner

Ingestion worker Edge Function for manual re-sync jobs.

## What it does

- Claims one or more jobs from `ingest_jobs` using lease-aware, skip-locked SQL helper (`claim_ingest_job`).
- Loads project/source context and decrypts owner Google refresh token.
- Fetches Drive content by source type:
  - Google Docs -> Drive export (`text/plain`)
  - Google Slides -> Drive export (`text/plain`, PDF fallback)
  - PDF -> file download (`alt=media`)
- Extracts and sanitizes text.
- For low-text PDFs, optionally falls back to OpenAI PDF extraction, capped by project OCR page limits.
- Chunks text with overlap, creates embeddings in batches, and replaces source chunks transactionally (`replace_source_chunks`).
- Enforces project hard caps for total stored chunks and emits guardrail audit events when limits are applied.
- Marks source/job success or failure and applies retry with exponential backoff.
- Emits ingestion audit events (`ingestion_completed`, `ingestion_failed`).

## Invocation

`POST /functions/v1/ingest_runner`

Runs as a worker; can process multiple jobs in one invocation (configurable).

## Required env vars

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `OPENAI_API_KEY`
- `TOKEN_ENCRYPTION_KEY` (+ optional `TOKEN_ENCRYPTION_KEY_VERSION`)  
  or `TOKEN_ENCRYPTION_KEYS` for key rotation

## Optional tuning env vars

- `INGEST_RUNNER_MAX_JOBS_PER_INVOCATION` (default `1`)
- `INGEST_JOB_LEASE_SECONDS` (default `300`)
- `INGEST_MAX_ATTEMPTS` (default `5`)
- `INGEST_CHUNK_SIZE_CHARS` (default `1200`)
- `INGEST_CHUNK_OVERLAP_CHARS` (default `200`)
- `INGEST_MAX_CHUNKS_PER_SOURCE` (default `300`)
- `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`)
- `OPENAI_EMBEDDING_BATCH_SIZE` (default `64`)
- `PDF_LOW_TEXT_MIN_CHARS` (default `600`)
- `PDF_MAX_BYTES_PER_FILE` (default `10485760`)
- `PDF_MAX_FALLBACKS_PER_RUN` (default `2`)
- `OPENAI_PDF_EXTRACTION_MODEL` (default `gpt-5-mini`)

## Project-level hard caps

Backed by `projects` settings:

- `max_sources` (enforced at DB insert trigger level)
- `max_total_chunks` (enforced during ingestion before upsert)
- `max_ocr_pages_per_sync` (prevents OCR fallback on oversized PDFs)
