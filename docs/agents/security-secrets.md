# Security and secrets (agent summary)

Secret-safe behavior for agents. Full inventory, storage, and rotation live in [../secrets.md](../secrets.md) — do not duplicate that content here.

## Rules to follow

1. **Never commit** real secret values. Use `.env` (gitignored), Supabase secrets, or CI secrets only.
2. **Never expose** secrets in frontend (`owner-app/`), widget (`widget/`), logs, or API responses. Only trusted server runtimes (Edge Functions, CI deploy) may read secrets.
3. **Owner app and widget** may use only public values (e.g. Supabase URL, anon key, OAuth client ID). No service role key, OAuth client secret, encryption keys, or OpenAI keys in browser or widget.
4. **Edge Functions** may read secrets from function env (Supabase secrets). Do not log secrets, OAuth codes, refresh tokens, or full LLM prompts that could contain secrets.
5. When **adding or changing** env or config: ensure new “secret” values are only ever used in server-side code and are listed and rotated per [../secrets.md](../secrets.md).

## When editing code

- Adding a new dependency on a secret: document it in [../secrets.md](../secrets.md) and keep usage in `supabase/functions/*` or CI only.
- Adding error messages or logs: keep them user-safe and free of stack traces or internal tokens; align with [../standards/error-schema.md](../standards/error-schema.md) logging guidance.

For inventory, rotation, and runtime boundaries, always refer to [../secrets.md](../secrets.md).
