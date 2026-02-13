# kb_resync

Owner-authenticated ingestion enqueue function for manual re-sync.

## What it does

- Validates owner session from the Supabase access token (`Authorization: Bearer ...`).
- Accepts `project_id` and optional `source_id`.
- Verifies project/source ownership using owner-scoped reads.
- Applies enqueue idempotency (skips sources already `queued`/`running` in `ingest_jobs`).
- Applies per-project guardrails for max running and max queued ingestion jobs.
- Enqueues new jobs in `ingest_jobs` and marks selected sources as `pending`.
- Logs `ingestion_started` audit events.

## Request

`POST /functions/v1/kb_resync`

```json
{
  "project_id": "uuid",
  "source_id": "uuid-optional"
}
```

## Response

```json
{
  "api_version": "v1",
  "request_id": "uuid",
  "data": {
    "project_id": "uuid",
    "job_ids": ["uuid"],
    "enqueued_count": 1,
    "skipped_existing_count": 0,
    "selected_source_count": 1
  }
}
```

## Guardrail env vars

- `INGEST_MAX_RUNNING_PER_PROJECT` (default `3`)
- `INGEST_MAX_QUEUED_PER_PROJECT` (default `100`)
