# Agent docs index

Navigation and when to use each doc.

## Sub-docs

| Doc | Use when |
|-----|----------|
| [repo-map.md](repo-map.md) | You need to know where code lives (`owner-app`, `widget`, `supabase`, `workers`) and who owns what. |
| [coding-workflow.md](coding-workflow.md) | You are adding or changing features: where to implement, how to stay aligned with standards, and minimal verification. |
| [testing-validation.md](testing-validation.md) | You need to run builds, tests, or manual checks for owner-app, widget, Edge Functions, or migrations. |
| [security-secrets.md](security-secrets.md) | You are touching env, secrets, or any code that could expose sensitive data; see also [../secrets.md](../secrets.md) for inventory and rotation. |

## Standards (do not duplicate)

- API contracts, error schema, audit events: [../standards/](../standards/)
- Secrets and rotation: [../secrets.md](../secrets.md)
- Deployment and Supabase setup: repo [README.md](../../README.md), [../supabase-setup.md](../supabase-setup.md)
