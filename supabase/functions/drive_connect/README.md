# drive_connect

Google OAuth callback Edge Function for owner Drive connection.

## What it does

- Validates callback `state` and owner session token.
- Exchanges Google OAuth `code` for tokens.
- Validates minimal Drive scope (`https://www.googleapis.com/auth/drive.file`).
- Encrypts refresh token before persisting to `google_connections`.
- Upserts Google identity + scopes for the current owner.
- Redirects back to owner app settings with success/error status query params.

## Required env vars

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `OWNER_APP_URL`
- `TOKEN_ENCRYPTION_KEY` (+ optional `TOKEN_ENCRYPTION_KEY_VERSION`)
  - or `TOKEN_ENCRYPTION_KEYS` for rotation (see below)

## Key rotation plan (read-old / write-new)

Use `TOKEN_ENCRYPTION_KEYS` with comma-separated `version:base64Key` entries, for example:

`TOKEN_ENCRYPTION_KEYS=1:<base64-old>,2:<base64-new>`

Behavior:

- **Write-new**: encryption always uses the highest version key.
- **Read-old**: decryption supports any configured version.
- Rotation rollout:
  1. Deploy with old+new keys configured.
  2. New writes use the new key version.
  3. Backfill/reconnect old records over time.
  4. Remove old key only after all rows are migrated.
