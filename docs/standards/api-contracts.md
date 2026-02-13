# API contract standards

Applies to all HTTP endpoints (Edge Functions and future API services).

## Core rules

1. JSON only request/response payloads.
2. Use explicit versioning in responses (`api_version`).
3. Stable field names once published; additive changes only for v1.
4. No secret material in payloads.

## Response envelope

All successful responses should follow:

```json
{
  "api_version": "v1",
  "request_id": "uuid-or-trace-id",
  "data": {}
}
```

Error responses should follow the schema in `docs/standards/error-schema.md`.

## Endpoint-specific expectations (Phase 0 draft)

- `embed_session`
  - request: `project_handle`
  - response `data`: `embed_token`, `expires_at`, `project_handle`
- `chat`
  - request: `embed_token`, `message`, optional `conversation_id`
  - response `data`: `answer`, `citations[]`, optional `warnings[]`
- `kb_resync`
  - request: `project_id` and optional `source_id`
  - response `data`: `job_ids[]`, `enqueued_count`

## Compatibility policy

- Backward-compatible additions: new nullable fields, new enum values (documented), new optional objects.
- Breaking changes require a new API version and migration notes.
