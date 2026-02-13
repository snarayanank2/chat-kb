# chat

RAG chat Edge Function for widget clients using short-lived embed tokens.

## Request

`POST /functions/v1/chat`

```json
{
  "embed_token": "<signed-token-from-embed-session>",
  "message": "What is the refund policy?"
}
```

## Success response

```json
{
  "api_version": "v1",
  "request_id": "uuid",
  "data": {
    "answer": "Refund requests are accepted within 30 days of purchase.",
    "citations": [
      {
        "source_id": "uuid",
        "title": "Customer FAQ",
        "chunk_id": 1201,
        "chunk_index": 4,
        "page": null,
        "slide": null,
        "file_id": "drive-file-id"
      }
    ],
    "warning_flags": [],
    "ui": {
      "has_citations": true
    }
  }
}
```

## Pipeline

1. Validate embed token signature + expiry + project/origin binding.
2. Enforce origin allowlist.
3. Enforce token-bucket rate limits.
4. Enforce request quotas and reserve usage counters.
5. Run input validation judge.
6. Retrieve chunks (`match_source_chunks`) and filter likely injection patterns.
7. Apply diversity ranking + per-source caps.
8. Generate answer with `UNTRUSTED_CONTEXT` fencing and structured citations.
9. Run output validation judge.
10. Record usage tokens and audit event.

## Error behavior

- `400 invalid_request`: invalid JSON or missing fields
- `400 invalid_origin_format`: missing/invalid `Origin`
- `401 invalid_embed_token` / `401 expired_embed_token`
- `403 blocked_origin`
- `429 rate_limited` (includes `retry_after_seconds` + `Retry-After` header)
- `429 quota_exceeded` (includes reset metadata + retry hints)
- `503 temporary_validation_failure`
- `500 internal_error` / `500 missing_configuration`

## Environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `EMBED_TOKEN_SIGNING_SECRET`
- `OPENAI_API_KEY`
- `OPENAI_CHAT_MODEL` (optional, default `gpt-4.1-mini`)
- `OPENAI_VALIDATION_MODEL` (optional, default `gpt-4.1-mini`)
- `OPENAI_EMBEDDING_MODEL` (optional, default `text-embedding-3-small`)
- `CHAT_RETRIEVAL_CANDIDATES` (optional, default `20`)
- `CHAT_RETRIEVAL_FINAL` (optional, default `8`)
- `CHAT_RETRIEVAL_MAX_PER_SOURCE` (optional, default `2`)

## Audit events

Writes to `audit_logs`:

- `chat_called`
- `blocked_origin`
- `rate_limited`
- `quota_exceeded`
- `validation_failed`
- `injection_pattern_detected`

`chat_called` and `rate_limited` are sampled to reduce high-volume log noise; all other events remain unsampled.
