begin;

create extension if not exists pgcrypto;
create extension if not exists vector;

create type public.source_type as enum ('gdoc', 'gslides', 'gpdf');
create type public.source_status as enum ('pending', 'processing', 'ready', 'failed');
create type public.ingest_job_status as enum ('queued', 'running', 'done', 'failed');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  handle text not null check (handle ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  allowed_origins text[] not null default '{}',
  rate_rpm integer not null default 60 check (rate_rpm > 0),
  rate_burst integer not null default 20 check (rate_burst > 0),
  quota_daily_requests integer not null default 1000 check (quota_daily_requests > 0),
  quota_monthly_requests integer not null default 20000 check (quota_monthly_requests > 0),
  quota_daily_tokens integer check (quota_daily_tokens is null or quota_daily_tokens > 0),
  quota_monthly_tokens integer check (quota_monthly_tokens is null or quota_monthly_tokens > 0),
  input_validation_prompt text not null default '',
  output_validation_prompt text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index projects_handle_idx on public.projects(handle);
create unique index projects_handle_lower_uidx on public.projects(lower(handle));

create table public.google_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  google_subject text not null,
  refresh_token_ciphertext bytea not null,
  nonce bytea not null,
  key_version integer not null check (key_version > 0),
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_type public.source_type not null,
  drive_file_id text not null,
  mime_type text,
  title text not null default '',
  drive_modified_time timestamptz,
  status public.source_status not null default 'pending',
  error text,
  last_ingested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, drive_file_id)
);

create index project_sources_project_status_idx
  on public.project_sources(project_id, status);

create table public.source_chunks (
  id bigserial primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  source_id uuid not null references public.project_sources(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (char_length(content) > 0),
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_id, chunk_index)
);

create index source_chunks_project_source_idx
  on public.source_chunks(project_id, source_id);

create index source_chunks_embedding_cosine_idx
  on public.source_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create table public.ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_id uuid references public.project_sources(id) on delete cascade,
  status public.ingest_job_status not null default 'queued',
  attempts integer not null default 0 check (attempts >= 0),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index ingest_jobs_status_created_idx
  on public.ingest_jobs(status, created_at);

create table public.rate_limit_buckets (
  project_id uuid primary key references public.projects(id) on delete cascade,
  bucket_tokens numeric(10,2) not null default 0 check (bucket_tokens >= 0),
  last_refill_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_usage_daily (
  project_id uuid not null references public.projects(id) on delete cascade,
  usage_date date not null,
  requests integer not null default 0 check (requests >= 0),
  tokens_in bigint not null default 0 check (tokens_in >= 0),
  tokens_out bigint not null default 0 check (tokens_out >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(project_id, usage_date)
);

create index project_usage_daily_project_date_idx
  on public.project_usage_daily(project_id, usage_date);

create table public.project_usage_monthly (
  project_id uuid not null references public.projects(id) on delete cascade,
  month_start date not null check (month_start = date_trunc('month', month_start)::date),
  requests integer not null default 0 check (requests >= 0),
  tokens_in bigint not null default 0 check (tokens_in >= 0),
  tokens_out bigint not null default 0 check (tokens_out >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(project_id, month_start)
);

create index project_usage_monthly_project_month_idx
  on public.project_usage_monthly(project_id, month_start);

create table public.audit_logs (
  id bigserial primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  event_type text not null check (event_type ~ '^[a-z0-9_]+$'),
  origin text,
  ip_hash text,
  user_agent text,
  request_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_project_timestamp_event_idx
  on public.audit_logs(project_id, created_at desc, event_type);

create trigger set_projects_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

create trigger set_google_connections_updated_at
before update on public.google_connections
for each row execute function public.set_updated_at();

create trigger set_project_sources_updated_at
before update on public.project_sources
for each row execute function public.set_updated_at();

create trigger set_source_chunks_updated_at
before update on public.source_chunks
for each row execute function public.set_updated_at();

create trigger set_ingest_jobs_updated_at
before update on public.ingest_jobs
for each row execute function public.set_updated_at();

create trigger set_rate_limit_buckets_updated_at
before update on public.rate_limit_buckets
for each row execute function public.set_updated_at();

create trigger set_project_usage_daily_updated_at
before update on public.project_usage_daily
for each row execute function public.set_updated_at();

create trigger set_project_usage_monthly_updated_at
before update on public.project_usage_monthly
for each row execute function public.set_updated_at();

create or replace function public.run_retention_policies(
  p_audit_log_retention interval default interval '180 days',
  p_usage_daily_retention interval default interval '400 days',
  p_usage_monthly_retention interval default interval '36 months'
)
returns table (
  deleted_audit_logs bigint,
  deleted_usage_daily bigint,
  deleted_usage_monthly bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_audit_deleted bigint := 0;
  v_daily_deleted bigint := 0;
  v_monthly_deleted bigint := 0;
begin
  delete from public.audit_logs
  where created_at < now() - p_audit_log_retention;
  get diagnostics v_audit_deleted = row_count;

  delete from public.project_usage_daily
  where usage_date < ((current_date::timestamp - p_usage_daily_retention)::date);
  get diagnostics v_daily_deleted = row_count;

  delete from public.project_usage_monthly
  where month_start < (date_trunc('month', current_date)::date - p_usage_monthly_retention);
  get diagnostics v_monthly_deleted = row_count;

  return query select v_audit_deleted, v_daily_deleted, v_monthly_deleted;
end;
$$;

comment on function public.run_retention_policies(interval, interval, interval) is
'Deletes old audit and usage rows. Schedule via pg_cron or external scheduler.';

revoke all on public.projects from anon;
revoke all on public.google_connections from anon;
revoke all on public.project_sources from anon;
revoke all on public.source_chunks from anon;
revoke all on public.ingest_jobs from anon;
revoke all on public.rate_limit_buckets from anon;
revoke all on public.project_usage_daily from anon;
revoke all on public.project_usage_monthly from anon;
revoke all on public.audit_logs from anon;

grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.google_connections to authenticated;
grant select, insert, update, delete on public.project_sources to authenticated;
grant select on public.source_chunks to authenticated;
grant select on public.ingest_jobs to authenticated;
grant select on public.rate_limit_buckets to authenticated;
grant select on public.project_usage_daily to authenticated;
grant select on public.project_usage_monthly to authenticated;
grant select on public.audit_logs to authenticated;

grant all privileges on public.projects to service_role;
grant all privileges on public.google_connections to service_role;
grant all privileges on public.project_sources to service_role;
grant all privileges on public.source_chunks to service_role;
grant all privileges on public.ingest_jobs to service_role;
grant all privileges on public.rate_limit_buckets to service_role;
grant all privileges on public.project_usage_daily to service_role;
grant all privileges on public.project_usage_monthly to service_role;
grant all privileges on public.audit_logs to service_role;
grant all privileges on all sequences in schema public to service_role;

alter table public.projects enable row level security;
alter table public.google_connections enable row level security;
alter table public.project_sources enable row level security;
alter table public.source_chunks enable row level security;
alter table public.ingest_jobs enable row level security;
alter table public.rate_limit_buckets enable row level security;
alter table public.project_usage_daily enable row level security;
alter table public.project_usage_monthly enable row level security;
alter table public.audit_logs enable row level security;

create policy projects_owner_all
on public.projects
for all
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

create policy google_connections_owner_all
on public.google_connections
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy project_sources_owner_all
on public.project_sources
for all
to authenticated
using (
  exists (
    select 1
    from public.projects p
    where p.id = project_sources.project_id
      and p.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.projects p
    where p.id = project_sources.project_id
      and p.owner_user_id = auth.uid()
  )
);

create policy source_chunks_owner_select
on public.source_chunks
for select
to authenticated
using (
  exists (
    select 1
    from public.projects p
    where p.id = source_chunks.project_id
      and p.owner_user_id = auth.uid()
  )
);

create policy ingest_jobs_owner_select
on public.ingest_jobs
for select
to authenticated
using (
  exists (
    select 1
    from public.projects p
    where p.id = ingest_jobs.project_id
      and p.owner_user_id = auth.uid()
  )
);

create policy rate_limit_buckets_owner_select
on public.rate_limit_buckets
for select
to authenticated
using (
  exists (
    select 1
    from public.projects p
    where p.id = rate_limit_buckets.project_id
      and p.owner_user_id = auth.uid()
  )
);

create policy project_usage_daily_owner_select
on public.project_usage_daily
for select
to authenticated
using (
  exists (
    select 1
    from public.projects p
    where p.id = project_usage_daily.project_id
      and p.owner_user_id = auth.uid()
  )
);

create policy project_usage_monthly_owner_select
on public.project_usage_monthly
for select
to authenticated
using (
  exists (
    select 1
    from public.projects p
    where p.id = project_usage_monthly.project_id
      and p.owner_user_id = auth.uid()
  )
);

create policy audit_logs_owner_select
on public.audit_logs
for select
to authenticated
using (
  exists (
    select 1
    from public.projects p
    where p.id = audit_logs.project_id
      and p.owner_user_id = auth.uid()
  )
);

commit;
