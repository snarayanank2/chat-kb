begin;

create or replace function public.consume_rate_limit(
  p_project_id uuid,
  p_rate_burst integer,
  p_rate_rpm integer,
  p_now timestamptz default now()
)
returns table (
  allowed boolean,
  tokens_remaining numeric,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket_tokens numeric(10,2);
  v_last_refill_at timestamptz;
  v_refill_per_second numeric;
  v_elapsed_seconds numeric;
  v_refilled_tokens numeric(10,2);
begin
  if p_rate_burst <= 0 or p_rate_rpm <= 0 then
    return query select false, 0::numeric, 60;
    return;
  end if;

  insert into public.rate_limit_buckets(project_id, bucket_tokens, last_refill_at)
  values (p_project_id, p_rate_burst::numeric, p_now)
  on conflict (project_id) do nothing;

  select b.bucket_tokens, b.last_refill_at
  into v_bucket_tokens, v_last_refill_at
  from public.rate_limit_buckets b
  where b.project_id = p_project_id
  for update;

  if v_bucket_tokens is null then
    return query select false, 0::numeric, 1;
    return;
  end if;

  v_refill_per_second := (p_rate_rpm::numeric / 60.0);
  v_elapsed_seconds := greatest(extract(epoch from (p_now - v_last_refill_at)), 0);
  v_refilled_tokens := least(
    p_rate_burst::numeric,
    v_bucket_tokens + (v_elapsed_seconds * v_refill_per_second)
  );

  if v_refilled_tokens >= 1 then
    v_refilled_tokens := v_refilled_tokens - 1;
    update public.rate_limit_buckets
    set
      bucket_tokens = v_refilled_tokens,
      last_refill_at = p_now
    where project_id = p_project_id;

    return query select true, v_refilled_tokens, 0;
    return;
  end if;

  update public.rate_limit_buckets
  set
    bucket_tokens = v_refilled_tokens,
    last_refill_at = p_now
  where project_id = p_project_id;

  return query
  select
    false,
    v_refilled_tokens,
    greatest(
      1,
      ceil((1 - v_refilled_tokens) / nullif(v_refill_per_second, 0))::integer
    );
end;
$$;

comment on function public.consume_rate_limit(uuid, integer, integer, timestamptz) is
'Token-bucket rate limiter. Consumes one request token when available.';

grant execute on function public.consume_rate_limit(uuid, integer, integer, timestamptz) to service_role;

create or replace function public.enforce_and_record_usage(
  p_project_id uuid,
  p_quota_daily_requests integer,
  p_quota_monthly_requests integer,
  p_quota_daily_tokens integer default null,
  p_quota_monthly_tokens integer default null,
  p_requests_increment integer default 1,
  p_tokens_in_increment bigint default 0,
  p_tokens_out_increment bigint default 0,
  p_now timestamptz default now()
)
returns table (
  allowed boolean,
  reason text,
  daily_requests integer,
  monthly_requests integer,
  daily_tokens bigint,
  monthly_tokens bigint,
  daily_reset_at timestamptz,
  monthly_reset_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := p_now::date;
  v_month date := date_trunc('month', p_now)::date;
  v_daily_row public.project_usage_daily%rowtype;
  v_monthly_row public.project_usage_monthly%rowtype;
  v_next_daily_requests integer;
  v_next_monthly_requests integer;
  v_next_daily_tokens bigint;
  v_next_monthly_tokens bigint;
  v_lock_key bigint;
begin
  if p_requests_increment < 0 or p_tokens_in_increment < 0 or p_tokens_out_increment < 0 then
    raise exception 'Usage increments must be non-negative';
  end if;

  v_lock_key := ('x' || substr(md5(p_project_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  insert into public.project_usage_daily(project_id, usage_date, requests, tokens_in, tokens_out)
  values (p_project_id, v_day, 0, 0, 0)
  on conflict (project_id, usage_date) do nothing;

  insert into public.project_usage_monthly(project_id, month_start, requests, tokens_in, tokens_out)
  values (p_project_id, v_month, 0, 0, 0)
  on conflict (project_id, month_start) do nothing;

  select * into v_daily_row
  from public.project_usage_daily
  where project_id = p_project_id and usage_date = v_day
  for update;

  select * into v_monthly_row
  from public.project_usage_monthly
  where project_id = p_project_id and month_start = v_month
  for update;

  v_next_daily_requests := v_daily_row.requests + p_requests_increment;
  v_next_monthly_requests := v_monthly_row.requests + p_requests_increment;
  v_next_daily_tokens :=
    v_daily_row.tokens_in + v_daily_row.tokens_out + p_tokens_in_increment + p_tokens_out_increment;
  v_next_monthly_tokens :=
    v_monthly_row.tokens_in + v_monthly_row.tokens_out + p_tokens_in_increment + p_tokens_out_increment;

  if p_quota_daily_requests is not null and v_next_daily_requests > p_quota_daily_requests then
    return query
    select
      false,
      'daily_requests',
      v_daily_row.requests,
      v_monthly_row.requests,
      v_daily_row.tokens_in + v_daily_row.tokens_out,
      v_monthly_row.tokens_in + v_monthly_row.tokens_out,
      date_trunc('day', p_now) + interval '1 day',
      date_trunc('month', p_now) + interval '1 month';
    return;
  end if;

  if p_quota_monthly_requests is not null and v_next_monthly_requests > p_quota_monthly_requests then
    return query
    select
      false,
      'monthly_requests',
      v_daily_row.requests,
      v_monthly_row.requests,
      v_daily_row.tokens_in + v_daily_row.tokens_out,
      v_monthly_row.tokens_in + v_monthly_row.tokens_out,
      date_trunc('day', p_now) + interval '1 day',
      date_trunc('month', p_now) + interval '1 month';
    return;
  end if;

  if p_quota_daily_tokens is not null and v_next_daily_tokens > p_quota_daily_tokens then
    return query
    select
      false,
      'daily_tokens',
      v_daily_row.requests,
      v_monthly_row.requests,
      v_daily_row.tokens_in + v_daily_row.tokens_out,
      v_monthly_row.tokens_in + v_monthly_row.tokens_out,
      date_trunc('day', p_now) + interval '1 day',
      date_trunc('month', p_now) + interval '1 month';
    return;
  end if;

  if p_quota_monthly_tokens is not null and v_next_monthly_tokens > p_quota_monthly_tokens then
    return query
    select
      false,
      'monthly_tokens',
      v_daily_row.requests,
      v_monthly_row.requests,
      v_daily_row.tokens_in + v_daily_row.tokens_out,
      v_monthly_row.tokens_in + v_monthly_row.tokens_out,
      date_trunc('day', p_now) + interval '1 day',
      date_trunc('month', p_now) + interval '1 month';
    return;
  end if;

  update public.project_usage_daily
  set
    requests = v_next_daily_requests,
    tokens_in = v_daily_row.tokens_in + p_tokens_in_increment,
    tokens_out = v_daily_row.tokens_out + p_tokens_out_increment
  where project_id = p_project_id and usage_date = v_day;

  update public.project_usage_monthly
  set
    requests = v_next_monthly_requests,
    tokens_in = v_monthly_row.tokens_in + p_tokens_in_increment,
    tokens_out = v_monthly_row.tokens_out + p_tokens_out_increment
  where project_id = p_project_id and month_start = v_month;

  return query
  select
    true,
    'ok',
    v_next_daily_requests,
    v_next_monthly_requests,
    v_daily_row.tokens_in + p_tokens_in_increment + v_daily_row.tokens_out + p_tokens_out_increment,
    v_monthly_row.tokens_in + p_tokens_in_increment + v_monthly_row.tokens_out + p_tokens_out_increment,
    date_trunc('day', p_now) + interval '1 day',
    date_trunc('month', p_now) + interval '1 month';
end;
$$;

comment on function public.enforce_and_record_usage(
  uuid,
  integer,
  integer,
  integer,
  integer,
  integer,
  bigint,
  bigint,
  timestamptz
) is
'Atomically checks request/token quotas and records usage counters.';

grant execute on function public.enforce_and_record_usage(
  uuid,
  integer,
  integer,
  integer,
  integer,
  integer,
  bigint,
  bigint,
  timestamptz
) to service_role;

create or replace function public.match_source_chunks(
  p_project_id uuid,
  p_query_embedding vector(1536),
  p_match_count integer default 16
)
returns table (
  id bigint,
  source_id uuid,
  chunk_index integer,
  content text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sc.id,
    sc.source_id,
    sc.chunk_index,
    sc.content,
    sc.metadata,
    1 - (sc.embedding <=> p_query_embedding) as similarity
  from public.source_chunks sc
  join public.project_sources ps
    on ps.id = sc.source_id
   and ps.project_id = p_project_id
   and ps.status = 'ready'
  where sc.project_id = p_project_id
  order by sc.embedding <=> p_query_embedding asc
  limit greatest(1, least(p_match_count, 100));
$$;

comment on function public.match_source_chunks(uuid, vector, integer) is
'Returns top semantic chunk matches for a project.';

grant execute on function public.match_source_chunks(uuid, vector, integer) to service_role;

commit;
