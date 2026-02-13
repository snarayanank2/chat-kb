# Error schema standard

All error responses must be machine-readable and safe to expose to clients.

## Response shape

```json
{
  "api_version": "v1",
  "request_id": "uuid-or-trace-id",
  "error": {
    "code": "blocked_origin",
    "message": "This chat is not enabled for this website.",
    "retryable": false,
    "details": {}
  }
}
```

## Field rules

- `code`: stable snake_case identifier for programmatic handling.
- `message`: user-safe text, no stack traces or secret data.
- `retryable`: `true` only if repeating later can succeed without changing input.
- `details`: optional structured metadata safe for clients.

## HTTP status mapping

- `400`: invalid payload (`invalid_request`, `invalid_origin_format`)
- `401`: auth/token problems (`invalid_embed_token`, `expired_embed_token`)
- `403`: policy blocks (`blocked_origin`)
- `404`: not found (`project_not_found`, `source_not_found`)
- `409`: conflict (`duplicate_source`, `resync_in_progress`)
- `429`: rate/usage controls (`rate_limited`, `quota_exceeded`)
- `500`: internal failures (`internal_error`)
- `503`: transient provider outages (`provider_unavailable`)

## Logging guidance

- Always log `request_id`, `error.code`, and high-level context.
- Never log raw secrets, OAuth codes, refresh tokens, or full LLM prompts containing secrets.
