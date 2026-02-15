Supabase + Google Drive Knowledge-Base Chat

Architecture Document (Widget-First, No Secrets)

Summary

Build a hosted SaaS where:
	•	Users sign in with Google via Supabase Auth.
	•	Users connect Google Drive via a separate, minimal-scope OAuth flow.
	•	Users create projects and attach specific Docs/Slides/PDFs as a knowledge base.
	•	The system ingests, chunks, embeds, and stores content per project.
	•	Third-party websites embed a chat widget (no secret). Access control is via allowed origins plus rate limits, quotas, and audit logs.
	•	Chat includes input/output validation and prompt-injection defenses, and returns citations.

⸻

1) Goals and Non-Goals

Goals
	•	Single-user projects (owner only).
	•	User-added Drive files only (manual URL/ID entry).
	•	Manual re-sync only (no polling).
	•	Embeddable web widget as the primary integration surface.
	•	Citations in answers (doc/slide/page).
	•	Safety hardening: input/output validation + prompt injection mitigations.
	•	Abuse controls: per-project rate limits, usage quotas, audit logs, and origin allowlist.

Non-goals (v1)
	•	Multi-user collaboration within a project.
	•	Auto re-sync on Drive changes.
	•	Perfect authentication for the widget without secrets (not possible with Origin alone).

⸻

2) High-level Architecture

Components
	1.	Frontend (Owner App)
	•	Project CRUD (create/list/delete)
	•	Configure allowed origins, rate limits, quotas
	•	Drive connect + manual source entry (Drive URL or file ID)
	•	Add/remove sources + trigger re-sync
	•	View ingestion status, audit summaries (optional)
	2.	Widget (Third-party Embed)
	•	widget.js loaded from your domain
	•	Creates an embed session, then chats using a short-lived token
	•	Displays citations and friendly errors (blocked origin, rate-limited, quota exceeded)
	3.	Supabase Hosted
	•	Auth: Google for owner login
	•	Postgres: projects, sources, chunks, embeddings, usage, audit logs
	•	pgvector: semantic retrieval
	•	Edge Functions: OAuth callback, ingestion, embed session, chat
	4.	Google APIs
	•	OAuth + Drive API (minimal scope)
	•	Drive export/download for Docs/Slides/PDFs
	5.	OpenAI
	•	Embeddings
	•	Chat generation
	•	Input validation and output validation
	•	PDF “OCR-like” extraction for scanned PDFs (via PDF file input)

⸻

3) Key Flows

3.1 Owner Login
	1.	Owner signs in using Supabase Auth (Google).
	2.	Owner creates projects, configures them, and manages sources.

3.2 Drive Connect (Separate OAuth)

Purpose: obtain refresh token and minimal Drive scope for later server-side fetching.
	1.	Owner clicks “Connect Drive”.
	2.	OAuth requests minimal Drive scope.
	3.	OAuth callback hits Edge Function drive_connect:
	•	exchange code → tokens
	•	store encrypted refresh token tied to owner user id

3.3 Add Source (Manual URL/ID entry)
	1.	Owner enters a Google Drive URL or file ID and source type (Doc/Slides/PDF) in project settings.
	2.	App stores file ID and metadata in project_sources.
	3.	Mark source as pending.

3.4 Manual Re-sync (Ingestion)
	1.	Owner clicks “Re-sync” for a source or project.
	2.	App enqueues ingestion jobs (ingest_jobs).
	3.	Worker function processes jobs:
	•	fetch content from Drive
	•	extract text (special handling for PDFs)
	•	chunk, embed, store chunks
	•	mark source as ready or failed

3.5 Widget Chat (No Secret)

Two-step handshake (recommended):
	1.	Widget calls embed_session with project_handle.
	•	Server checks request Origin is allowed.
	•	Server returns short-lived embed token bound to project + origin + expiry.
	2.	Widget calls chat with the embed token + message.
	•	Server validates token, enforces origin, rate limits, quotas
	•	Runs RAG + validations + citations
	•	Logs audit events

⸻

4) Trust Model and Security Notes

Reality: Origin allowlist is not authentication
	•	Browsers enforce Origin/CORS for embedded usage.
	•	Non-browser clients can spoof headers.
	•	Therefore:
	•	Origin allowlist primarily prevents “unauthorized embedding in browsers”
	•	Abuse controls must rely on rate limits, quotas, monitoring, and optional friction

Never expose sensitive credentials
	•	No Supabase service role key in frontend or widget.
	•	No Google refresh tokens to browser.
	•	No OpenAI keys to browser.

⸻

5) Prompt Injection and Safety Defenses

5.1 Input validation (project-specific)
	•	A “judge” call determines whether to accept user input.
	•	Blocks:
	•	malicious intent / policy-violating content (as per your rules)
	•	attempts to override system/developer instructions
	•	“ignore previous instructions”-style attacks
	•	requests for secrets/tokens/system prompts

5.2 Output validation (project-specific)
	•	Post-generation judge checks:
	•	no instruction-following from retrieved context
	•	no fabricated citations
	•	no sensitive claims (“I accessed your Drive tokens…”)
	•	citations included for factual claims

5.3 Retrieval hardening
	•	Treat retrieved documents as UNTRUSTED_CONTEXT
	•	Filter chunks containing obvious injection patterns (rule-based + optional small judge)
	•	Cap per-source contribution (e.g., max 2 chunks per document) to prevent dominance
	•	MMR/diversity retrieval (avoid single malicious chunk winning)

5.4 System prompt structure (fixed template)
	•	System policy (non-negotiable)
	•	Developer instructions (app rules)
	•	Retrieved context fenced and labeled UNTRUSTED
	•	User query
This reduces the chance that retrieved text hijacks instructions.

5.5 Citation-gated answering
	•	Require citations for claims derived from KB
	•	Validation fails if citations are missing or mismatched

⸻

6) Abuse Controls

6.1 Allowed origins (per project)
	•	Owner provides strict origins list:
	•	https://example.com
	•	https://sub.example.com
	•	Matching is exact (avoid wildcard unless absolutely needed)
	•	Enforcement at:
	•	embed_session (block early)
	•	chat (block again)

6.2 Rate limiting (per project)
	•	Token bucket (burst + refill rate)
	•	Enforced at chat and optionally embed_session
	•	Returns HTTP 429 when exceeded
	•	Logs rate_limited audit events

6.3 Usage quotas (per project)
	•	Daily + monthly request caps
	•	Optional token caps (input/output)
	•	Returns quota exceeded error (commonly 429 or 402-like semantics)
	•	Logs quota_exceeded audit events

6.4 Audit logs

Record:
	•	embed session created / blocked origin
	•	chat called
	•	rate-limited / quota exceeded
	•	validation failed / injection pattern detected
	•	ingestion started / failed / completed
Store minimal PII (hash IP if stored at all).

⸻

7) Data Model

7.1 Core tables

projects
	•	id (uuid, pk)
	•	owner_user_id (uuid)
	•	name
	•	handle (unique) – used in widget embed
	•	allowed_origins (text[])
	•	rate_rpm, rate_burst
	•	quota_daily_requests, quota_monthly_requests
	•	quota_daily_tokens?, quota_monthly_tokens?
	•	input_validation_prompt, output_validation_prompt
	•	timestamps

google_connections
	•	user_id (pk)
	•	google_subject
	•	refresh_token_ciphertext, nonce, key_version
	•	scopes
	•	timestamps

project_sources
	•	id (uuid, pk)
	•	project_id
	•	source_type (gdoc|gslides|gpdf)
	•	drive_file_id, mime_type, title
	•	drive_modified_time?
	•	status (pending|processing|ready|failed)
	•	error?, last_ingested_at?

source_chunks
	•	id
	•	project_id, source_id
	•	chunk_index
	•	content
	•	metadata (jsonb) includes title, file_id, page or slide
	•	embedding (vector)
	•	timestamps

7.2 Ingestion + controls

ingest_jobs
	•	id
	•	project_id, source_id
	•	status (queued|running|done|failed)
	•	attempts
	•	error?
	•	timestamps

rate_limit_buckets
	•	project_id (pk)
	•	bucket_tokens
	•	last_refill_at

project_usage_daily
	•	project_id
	•	date
	•	requests
	•	tokens_in, tokens_out

project_usage_monthly
	•	project_id
	•	month (first day)
	•	requests
	•	tokens_in, tokens_out

audit_logs
	•	id
	•	project_id
	•	event_type
	•	origin?, ip_hash?, user_agent?
	•	request_id
	•	metadata (jsonb)
	•	timestamp

⸻

8) Authorization and RLS

Owner app
	•	Standard Supabase JWT from Auth.
	•	RLS policies restrict owner access by owner_user_id = auth.uid().

Widget
	•	No Supabase auth.
	•	Uses Edge Functions that:
	•	validate allowed origin
	•	issue short-lived embed token
	•	enforce limits/quotas
	•	DB access from Edge Functions uses service role (bypasses RLS by design), so function code must apply checks explicitly.

⸻

9) Edge Functions

drive_connect
	•	OAuth callback endpoint
	•	Exchanges code for tokens
	•	Encrypts and stores refresh token

kb_resync
	•	Enqueues ingestion jobs for a source/project
	•	Owner-authenticated only

ingest_runner (or job worker)
	•	Claims queued jobs
	•	Fetches Drive content using stored refresh token
	•	Extracts text:
	•	Docs/Slides: export text/HTML → sanitize
	•	PDFs: attempt text extraction; if low text, use OpenAI PDF-based extraction
	•	Chunk → embed → store → mark ready/failed
	•	Logs audit events

embed_session
	•	Input: project_handle
	•	Checks Origin against project allowlist
	•	Issues short-lived embed token bound to origin + project
	•	Logs embed_session_created / blocked_origin

chat
	•	Validates embed token + origin
	•	Enforces rate limits + quotas
	•	Runs:
	1.	input validation judge
	2.	retrieval (pgvector similarity search, filtered by project)
	3.	answer generation with UNTRUSTED context
	4.	output validation judge (citations required)
	•	Logs audit events and usage counters

⸻

10) Chat Algorithm (RAG + citations)
	1.	Validate embedding token
	2.	Origin check
	3.	Rate limit
	4.	Quota check
	5.	Input validation
	6.	Embed query
	7.	Retrieve top chunks from source_chunks by similarity
	•	diversify results (MMR)
	•	cap per-source chunks
	•	filter injection-like chunks
	8.	Compose prompt
	•	retrieved snippets inside UNTRUSTED_CONTEXT block
	9.	Generate answer
	10.	Output validation
	•	must include citations for KB-derived claims
	11.	Return
	•	answer
	•	citations[] (structured)
	•	optional blocks for UI highlighting

⸻

11) Widget Product Design

Default UX
	•	Floating bubble + expandable panel
	•	Streaming responses
	•	Source citation chips (click to view doc title/page/slide)
	•	Error states:
	•	“This chat is not enabled for this website” (origin blocked)
	•	“Rate limit reached, try again later”
	•	“Quota exceeded”

Optional enhancements
	•	Theme configuration (colors, position, welcome text)
	•	Conversation export (owner-only)
	•	“Feedback: helpful/not helpful” stored in audit metadata

⸻

12) Automation and Deployment

Repository layout

/supabase
  /migrations
  /functions
    drive_connect/
    kb_resync/
    ingest_runner/
    embed_session/
    chat/
widget/
  widget.js (build output)
owner-app/
  (frontend)

Automated setup
	•	Supabase CLI:
	•	apply migrations
	•	deploy Edge Functions
	•	set function secrets (OpenAI key, Google OAuth secrets, encryption key)
	•	CI pipeline runs on main branch to deploy.

⸻

13) Operational Guardrails
	•	Hard caps: max sources/project, max pages OCR’d per sync, max total chunks.
	•	Timeout discipline: ingestion jobs retry with backoff.
	•	Sampling logs for high-volume events (rate limited) to control DB growth.
	•	Cost controls:
	•	separate model for validation (cheap)
	•	embeddings batch upserts
	•	OCR only when necessary

⸻

14) Mermaid Diagram

flowchart LR
  Owner[Owner App] -->|Supabase Auth JWT| SupaAuth[Supabase Auth]
  Owner -->|Project CRUD| DB[(Postgres + pgvector)]
  Owner -->|Drive OAuth| DriveConnect[Edge: drive_connect]
  DriveConnect --> DB

  Owner -->|Add sources (URL or file ID)| DB

  Owner -->|Re-sync| Resync[Edge: kb_resync] --> Jobs[(ingest_jobs)]
  Runner[Edge: ingest_runner] --> Jobs
  Runner -->|Fetch file| GoogleDrive[Google Drive API]
  Runner -->|Extract text/OCR| OpenAI[OpenAI]
  Runner -->|Chunk + Embed| OpenAI
  Runner --> DB

  Site[3rd Party Website] -->|loads| Widget[widget.js]
  Widget -->|embed_session (Origin check)| EmbedSess[Edge: embed_session]
  EmbedSess -->|token| Widget
  Widget -->|chat + token| Chat[Edge: chat]
  Chat -->|rate/quota/audit| DB
  Chat -->|retrieve| DB
  Chat -->|LLM + validation| OpenAI
  Chat -->|answer + citations| Widget

