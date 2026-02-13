# Supabase + Google Drive Chatbot Implementation Plan

## Planning assumptions
- Target is **v1** from the architecture doc: single-owner projects, manual re-sync, widget-first integration, no browser-held secrets.
- Build order prioritizes a secure end-to-end slice first, then hardening and operational work.
- Tasks are written so each item is independently trackable and can be moved into issues/tickets.

## Milestones
- M1: Foundations + data model + owner auth
- M2: Drive connect + source management + manual re-sync ingestion
- M3: Widget handshake + chat RAG + citations
- M4: Safety/abuse hardening + observability
- M5: QA, load checks, deployment automation, launch

## Phase 0 - Repo and environment setup
- [x] Create mono-repo/app layout (`supabase/`, `owner-app/`, `widget/`) per architecture.
- [x] Add local/dev/prod environment templates (`.env.example`) with required non-secret placeholders.
- [x] Define secret inventory and storage strategy for:
  - Supabase service role key (server only)
  - OpenAI API key
  - Google OAuth client secret
  - Encryption key for refresh tokens
- [x] Configure Supabase CLI for local and remote projects.
- [x] Add basic CI pipeline skeleton (lint/test/build/deploy jobs with staged gates).
- [x] Add coding standards docs for API contracts, error schema, and audit event naming.

## Phase 1 - Database schema, indexes, and access controls

### 1.1 Core schema migrations
- [ ] Create `projects` table with handle uniqueness, quotas, rate config, validation prompts, timestamps.
- [ ] Create `google_connections` table with encrypted refresh token fields (`refresh_token_ciphertext`, `nonce`, `key_version`), scopes, timestamps.
- [ ] Create `project_sources` table with source metadata and ingestion status lifecycle.
- [ ] Create `source_chunks` with chunk metadata and vector column for embeddings.
- [ ] Create ingestion/control tables:
  - `ingest_jobs`
  - `rate_limit_buckets`
  - `project_usage_daily`
  - `project_usage_monthly`
  - `audit_logs`

### 1.2 Constraints, indexes, and retention
- [ ] Add FK constraints and cascade rules for project deletion safety.
- [ ] Add indexes for:
  - `projects(handle)`
  - `project_sources(project_id, status)`
  - `source_chunks(project_id, source_id)`
  - `ingest_jobs(status, created_at)`
  - usage tables by `(project_id, date/month)`
  - `audit_logs(project_id, timestamp, event_type)`
- [ ] Add pgvector extension and similarity index strategy suitable for expected scale.
- [ ] Define retention and archival policies for audit and usage data.

### 1.3 RLS and server access model
- [ ] Enable RLS on owner-facing tables.
- [ ] Add policies restricting owner access to `owner_user_id = auth.uid()`.
- [ ] Keep widget-facing access out of direct DB; route through Edge Functions with service-role checks.
- [ ] Add migration tests/verification SQL for policy correctness.

## Phase 2 - Owner app skeleton and authentication

### 2.1 Owner auth and app shell
- [ ] Implement Supabase Auth (Google sign-in) in `owner-app`.
- [ ] Add authenticated app shell and sign-out/session refresh behavior.
- [ ] Create protected routes for project dashboard and settings pages.

### 2.2 Project CRUD and configuration
- [ ] Implement project create/list/delete.
- [ ] Add project `handle` creation and uniqueness validation UX.
- [ ] Build settings UI for:
  - allowed origins list
  - rate limits (rpm/burst)
  - request/token quotas
  - input/output validation prompts
- [ ] Add owner-side validation for origin format and exact-match policy.

### 2.3 Observability hooks in owner app
- [ ] Show source and ingestion status badges (`pending/processing/ready/failed`).
- [ ] Add minimal usage summary view (daily/monthly requests, token counts).
- [ ] Add audit summary filters for high-signal events (blocked origin, rate-limited, quota-exceeded, ingestion failures).

## Phase 3 - Google Drive connect and source registration

### 3.1 Drive OAuth function (`drive_connect`)
- [ ] Implement OAuth callback Edge Function:
  - exchange code for tokens
  - retrieve Google subject/account identity
  - encrypt refresh token
  - persist in `google_connections`
- [ ] Restrict requested scopes to minimal file-picker compatible scope.
- [ ] Add robust error mapping (expired code, consent revoked, insufficient scopes).

### 3.2 Encryption utilities
- [ ] Implement server-side encrypt/decrypt utility with key versioning support.
- [ ] Add key rotation plan (read-old/write-new strategy).
- [ ] Add unit tests for encryption roundtrip and invalid key handling.

### 3.3 File picker + source linking
- [ ] Integrate Google file picker in owner app.
- [ ] Support allowed source types: Docs, Slides, PDF.
- [ ] Persist source selections into `project_sources` with status `pending`.
- [ ] Add duplicate-source detection by `(project_id, drive_file_id)`.
- [ ] Provide source list UI with remove/re-sync actions.

## Phase 4 - Ingestion pipeline (manual re-sync)

### 4.1 Re-sync trigger (`kb_resync`)
- [ ] Implement owner-authenticated endpoint for source/project re-sync.
- [ ] Enqueue jobs in `ingest_jobs` with idempotency guards.
- [ ] Add per-project concurrency guardrails for ingestion.

### 4.2 Job worker (`ingest_runner`)
- [ ] Implement job claiming with safe lock/lease semantics.
- [ ] Load project/source context and decrypt owner refresh token.
- [ ] Fetch content via Drive API by source type:
  - Docs/Slides export path
  - PDFs download path
- [ ] Extract and sanitize text content for chunking.
- [ ] Implement retry with exponential backoff and terminal failure states.

### 4.3 PDF extraction strategy
- [ ] Implement baseline PDF text extraction.
- [ ] Add low-text detection heuristics.
- [ ] Add OpenAI-based PDF extraction fallback only when needed.
- [ ] Add hard limits (pages/files per sync) to control cost.

### 4.4 Chunking, embeddings, and storage
- [ ] Define chunking strategy (size, overlap, separators).
- [ ] Generate embeddings in batches for cost/perf efficiency.
- [ ] Replace prior chunks atomically per source during re-sync.
- [ ] Persist chunk metadata with citation anchors (doc title + page/slide).
- [ ] Mark source status and timestamps on success/failure.

## Phase 5 - Widget session handshake and embed UX

### 5.1 `embed_session` function
- [ ] Validate `project_handle` and resolve project settings.
- [ ] Enforce exact-match origin allowlist.
- [ ] Create short-lived embed token bound to project + origin + expiry.
- [ ] Log `embed_session_created` and `blocked_origin` events.
- [ ] Return client-safe structured error payloads.

### 5.2 Widget SDK (`widget.js`)
- [ ] Build embeddable loader + floating bubble UI.
- [ ] Implement session initialization flow (`embed_session` then `chat`).
- [ ] Add graceful error states:
  - blocked origin
  - rate limited
  - quota exceeded
  - generic temporary failure
- [ ] Render citations in response cards/chips.
- [ ] Support basic theming options (position/colors/welcome text).

## Phase 6 - Chat endpoint with RAG + safety gates

### 6.1 Chat request pipeline (`chat`)
- [ ] Validate embed token signature, expiry, origin binding, and project binding.
- [ ] Enforce token bucket rate limiting (burst/refill).
- [ ] Enforce daily/monthly usage quotas before model calls.
- [ ] Record usage counters atomically (requests + tokens).

### 6.2 Retrieval and ranking
- [ ] Embed query text with embedding model.
- [ ] Retrieve top chunks from `source_chunks` filtered by project.
- [ ] Add MMR/diversity logic to avoid single-source dominance.
- [ ] Cap max chunks per source for resilience against malicious docs.
- [ ] Add injection-pattern filtering on retrieved chunks.

### 6.3 Generation and validation
- [ ] Build fixed prompt template with explicit `UNTRUSTED_CONTEXT` fencing.
- [ ] Run input validation judge before retrieval/generation.
- [ ] Generate answer with required structured citation output.
- [ ] Run output validation judge for citation integrity and policy checks.
- [ ] If validation fails, return safe fallback response and log reason.

### 6.4 Response contract
- [ ] Return normalized schema:
  - `answer`
  - `citations[]` (source id/title/page/slide/chunk refs)
  - optional UI blocks / warning flags
- [ ] Version response contract for future compatibility (`api_version`).
- [ ] Document API contract for widget and future SDK consumers.

## Phase 7 - Abuse controls, auditability, and guardrails

### 7.1 Abuse controls
- [ ] Implement exact origin canonicalization and matching rules.
- [ ] Add rate-limit responses (`429`) with retry hints.
- [ ] Add quota exceeded responses with period reset metadata.
- [ ] Add per-project hard caps (max sources, max chunks, max OCR pages).

### 7.2 Audit and telemetry
- [ ] Standardize event taxonomy and metadata schema for `audit_logs`.
- [ ] Log high-value events only; sample noisy high-volume events.
- [ ] Hash or omit raw IP data to minimize PII footprint.
- [ ] Add request IDs and trace correlation across function calls.

### 7.3 Admin/operator tooling
- [ ] Build basic operator queries/dashboards for top failure reasons.
- [ ] Add alerting thresholds for:
  - spike in blocked origins
  - repeated validation failures
  - ingestion backlog growth
  - quota/rate anomalies

## Phase 8 - Testing and quality gates

### 8.1 Unit and integration tests
- [ ] DB migration tests (constraints, indexes, policies).
- [ ] Function unit tests:
  - token validation
  - origin checks
  - rate/quota math
  - encryption utilities
  - citation parser/validator
- [ ] Integration tests for end-to-end flows:
  - owner login -> project create
  - drive connect -> add source -> re-sync
  - widget session -> chat answer with citations

### 8.2 Security and adversarial tests
- [ ] Prompt-injection test corpus against retrieval and judge stages.
- [ ] Malformed token/origin spoofing test cases for widget endpoints.
- [ ] Quota/rate abuse simulation.
- [ ] Secret exposure checks in logs and API responses.

### 8.3 Performance and cost tests
- [ ] Benchmark ingestion throughput and chat p95 latency.
- [ ] Validate vector search performance with representative chunk counts.
- [ ] Compare validation/generation model cost envelopes.
- [ ] Verify OCR fallback frequency is within budget targets.

## Phase 9 - Deployment, release, and runbook

### 9.1 CI/CD and environment promotion
- [ ] Finalize CI pipeline: lint/test/build, migration check, function deploy.
- [ ] Add environment promotion workflow (dev -> staging -> prod).
- [ ] Add secret provisioning checks for required Edge Function secrets.

### 9.2 Release readiness checklist
- [ ] Confirm all critical audit events are emitted and queryable.
- [ ] Confirm owner UX handles all major failure modes gracefully.
- [ ] Confirm widget works from allowed origin and fails safely elsewhere.
- [ ] Confirm manual re-sync recovery path after ingestion failures.

### 9.3 Operations runbook
- [ ] Write incident playbooks for:
  - Google token revocation/expiry
  - ingestion queue backlog
  - OpenAI outage/degradation
  - runaway usage/cost
- [ ] Document SLO targets and support escalation paths.

## Suggested first sprint (high-impact path)
- [ ] Build schema + RLS + indexes.
- [ ] Implement owner auth and project CRUD/settings.
- [ ] Implement `drive_connect` with encryption.
- [ ] Implement `kb_resync` + minimal `ingest_runner` for one source type (Docs first).
- [ ] Implement `embed_session` + simple widget shell.
- [ ] Implement initial `chat` with retrieval, citations, and basic rate/quota checks.

## Definition of done for v1
- [ ] Owner can connect Drive, select files, and manually re-sync successfully.
- [ ] Widget can be embedded on allowed origins and blocked elsewhere.
- [ ] Chat answers include citations tied to ingested sources.
- [ ] Input/output validation and retrieval hardening are active in production.
- [ ] Rate limits, quotas, and audit logs are enforceable and observable.
- [ ] CI/CD deploys migrations and functions reproducibly.
