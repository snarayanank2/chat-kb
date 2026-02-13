# Secret inventory and storage strategy

This project uses a strict **server-only secret** model. No secret appears in browser bundles, widget payloads, or committed files.

## Secret inventory

| Secret | Used by | Storage location | Rotation target |
| --- | --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions/server workflows | CI secret manager + Supabase function secrets | 90 days |
| `OPENAI_API_KEY` | Ingestion + chat functions | CI secret manager + Supabase function secrets | 90 days |
| `GOOGLE_OAUTH_CLIENT_SECRET` | `drive_connect` token exchange | CI secret manager + Supabase function secrets | 90 days |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth flow config | Env config (non-secret but managed) | On app registration updates |
| `TOKEN_ENCRYPTION_KEY` | Refresh token encryption/decryption | KMS-backed secret manager (preferred) / CI secrets | 90 days |

## Required handling rules

1. Never commit real secret values.
2. Never expose secrets in frontend code, widget code, logs, or error responses.
3. Only access secrets inside trusted server runtimes (Edge Functions, CI deploy jobs).
4. Treat refresh tokens and encrypted payloads as sensitive data.
5. Use separate secret values per environment (`dev`, `staging`, `prod`).

## Runtime boundaries

- `owner-app/` and `widget/` may use public values only (for example, Supabase URL and anon key).
- `supabase/functions/*` may read server secrets from function env vars.
- CI deploy job injects secrets only at deploy/runtime steps, never in build artifacts.

## Rotation and incident response (v1 baseline)

- Maintain key version metadata for encrypted refresh tokens.
- Prefer read-old/write-new rotation strategy:
  - decryption accepts current and previous key versions
  - encryption always uses the newest active key
- On possible leakage:
  1. Revoke impacted keys/tokens immediately.
  2. Rotate secret values.
  3. Reconnect affected Google integrations if refresh tokens are invalidated.
  4. Review audit logs for abnormal usage windows.
