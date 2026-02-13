# embed_session

Issues short-lived widget session tokens after enforcing strict project origin canonicalization + allowlist rules.

## Request

`POST /functions/v1/embed_session`

```json
{
  "project_handle": "my-project-handle"
}
```

## Success response

```json
{
  "api_version": "v1",
  "request_id": "uuid",
  "data": {
    "embed_token": "<signed-token>",
    "expires_at": "2026-02-13T12:00:00.000Z",
    "project_handle": "my-project-handle"
  }
}
```

## Error behavior

- `400 invalid_request`: invalid JSON or missing `project_handle`
- `400 invalid_origin_format`: request `Origin` header missing/invalid
- `403 blocked_origin`: origin not in project allowlist
- `404 project_not_found`: unknown project handle
- `500 missing_configuration` or `500 internal_error`

## Environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `EMBED_TOKEN_SIGNING_SECRET`
- `EMBED_TOKEN_TTL_SECONDS` (optional, defaults to 300, max 3600)

## Audit events

Writes to `audit_logs`:

- `embed_session_created`
- `blocked_origin`
