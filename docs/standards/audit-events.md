# Audit event naming standard

Defines taxonomy and naming consistency for `audit_logs.event_type`.

## Naming format

Use lowercase snake_case and `<domain>_<action>`:

- `embed_session_created`
- `blocked_origin`
- `chat_called`
- `rate_limited`
- `quota_exceeded`
- `validation_failed`
- `ingestion_started`
- `ingestion_failed`
- `ingestion_completed`
- `ingestion_guardrail_enforced`

## Domain sets (v1)

- Session/origin:
  - `embed_session_created`
  - `blocked_origin`
- Chat usage:
  - `chat_called`
  - `rate_limited`
  - `quota_exceeded`
- Safety:
  - `validation_failed`
  - `injection_pattern_detected`
- Ingestion:
  - `ingestion_started`
  - `ingestion_failed`
  - `ingestion_completed`
  - `ingestion_guardrail_enforced`

## Metadata schema (v1)

All events store structured metadata in `audit_logs.metadata` with:

- `schema_version` (required, integer, currently `1`)
- `function_name` (required, edge function source)
- `trace_id` (required when available from headers)

High-volume events may include sampling metadata:

- `sample_rate` (number between `0` and `1`)

## Required metadata keys

Each audit event should include the following keys when available:

- `request_id`
- `project_id`
- `origin`
- `status`

Optional:

- `source_id`
- `error_code`
- `latency_ms`
- `tokens_in`
- `tokens_out`

## Privacy rules

- Do not store raw IP by default; prefer hashed value if needed.
- Do not store message content unless explicitly approved and redacted policy is defined.
