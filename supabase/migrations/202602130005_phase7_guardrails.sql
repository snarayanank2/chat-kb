begin;

alter table public.projects
  add column if not exists max_sources integer not null default 200 check (max_sources > 0),
  add column if not exists max_total_chunks integer not null default 50000 check (max_total_chunks > 0),
  add column if not exists max_ocr_pages_per_sync integer not null default 40 check (max_ocr_pages_per_sync > 0);

create or replace function public.enforce_project_source_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_sources integer;
  v_source_count integer;
begin
  select p.max_sources
  into v_max_sources
  from public.projects p
  where p.id = new.project_id;

  if v_max_sources is null then
    raise exception 'Project % not found', new.project_id;
  end if;

  select count(*)
  into v_source_count
  from public.project_sources ps
  where ps.project_id = new.project_id;

  if v_source_count >= v_max_sources then
    raise exception 'project_source_cap_exceeded'
      using errcode = 'P0001',
      detail = format(
        'Project %s already has %s sources (max %s).',
        new.project_id,
        v_source_count,
        v_max_sources
      );
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_project_source_cap on public.project_sources;

create trigger enforce_project_source_cap
before insert on public.project_sources
for each row
execute function public.enforce_project_source_cap();

create or replace view public.ops_event_counts_15m as
select
  date_trunc('minute', a.created_at) as minute_bucket,
  a.event_type,
  count(*) as event_count
from public.audit_logs a
where a.created_at >= now() - interval '15 minutes'
group by 1, 2
order by 1 desc, 2 asc;

create or replace view public.ops_top_failure_reasons_24h as
select
  a.event_type,
  coalesce(a.metadata ->> 'reason', a.metadata ->> 'error', 'unspecified') as reason,
  count(*) as occurrences
from public.audit_logs a
where
  a.created_at >= now() - interval '24 hours'
  and a.event_type in ('validation_failed', 'ingestion_failed', 'quota_exceeded', 'rate_limited', 'blocked_origin')
group by 1, 2
order by occurrences desc, a.event_type asc;

create or replace view public.ops_ingestion_backlog as
select
  ij.project_id,
  count(*) filter (where ij.status = 'queued') as queued_jobs,
  count(*) filter (where ij.status = 'running') as running_jobs,
  min(ij.created_at) filter (where ij.status = 'queued') as oldest_queued_at,
  extract(epoch from (now() - min(ij.created_at) filter (where ij.status = 'queued')))::bigint as oldest_queued_age_seconds
from public.ingest_jobs ij
where ij.status in ('queued', 'running')
group by ij.project_id
order by queued_jobs desc, running_jobs desc;

create or replace view public.ops_alert_signals as
with recent as (
  select
    count(*) filter (
      where event_type = 'blocked_origin' and created_at >= now() - interval '15 minutes'
    ) as blocked_origin_15m,
    count(*) filter (
      where event_type = 'validation_failed' and created_at >= now() - interval '15 minutes'
    ) as validation_failed_15m,
    count(*) filter (
      where event_type in ('quota_exceeded', 'rate_limited') and created_at >= now() - interval '15 minutes'
    ) as quota_rate_anomalies_15m
  from public.audit_logs
)
select
  r.blocked_origin_15m,
  r.validation_failed_15m,
  r.quota_rate_anomalies_15m,
  coalesce(sum(b.queued_jobs), 0)::bigint as queued_jobs_total,
  coalesce(max(b.oldest_queued_age_seconds), 0)::bigint as max_oldest_queue_age_seconds,
  (r.blocked_origin_15m >= 50) as alert_blocked_origin_spike,
  (r.validation_failed_15m >= 30) as alert_validation_failures_spike,
  (coalesce(sum(b.queued_jobs), 0) >= 200 or coalesce(max(b.oldest_queued_age_seconds), 0) >= 900) as alert_ingestion_backlog_growth,
  (r.quota_rate_anomalies_15m >= 150) as alert_quota_rate_anomalies
from recent r
left join public.ops_ingestion_backlog b on true
group by r.blocked_origin_15m, r.validation_failed_15m, r.quota_rate_anomalies_15m;

grant select on public.ops_event_counts_15m to authenticated, service_role;
grant select on public.ops_top_failure_reasons_24h to authenticated, service_role;
grant select on public.ops_ingestion_backlog to authenticated, service_role;
grant select on public.ops_alert_signals to authenticated, service_role;

comment on view public.ops_event_counts_15m is
'Operator dashboard: event counts in the last 15 minutes.';

comment on view public.ops_top_failure_reasons_24h is
'Operator dashboard: top failure reasons by event type over 24 hours.';

comment on view public.ops_ingestion_backlog is
'Operator dashboard: ingestion queue depth and age by project.';

comment on view public.ops_alert_signals is
'Operator dashboard: threshold-based alert booleans for abuse and ingestion anomalies.';

commit;
