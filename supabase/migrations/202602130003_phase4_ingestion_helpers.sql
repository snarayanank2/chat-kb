begin;

create or replace function public.claim_ingest_job(
  p_lease_seconds integer default 300,
  p_max_attempts integer default 5,
  p_project_id uuid default null
)
returns table (
  id uuid,
  project_id uuid,
  source_id uuid,
  attempts integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select j.id
    from public.ingest_jobs j
    where (p_project_id is null or j.project_id = p_project_id)
      and j.attempts < p_max_attempts
      and (
        j.status = 'queued'
        or (
          j.status = 'running'
          and j.started_at is not null
          and j.started_at < now() - make_interval(secs => p_lease_seconds)
        )
      )
    order by j.created_at asc
    for update skip locked
    limit 1
  ),
  updated as (
    update public.ingest_jobs j
    set
      status = 'running',
      started_at = now(),
      attempts = j.attempts + 1,
      error = null
    from candidate c
    where j.id = c.id
    returning j.id, j.project_id, j.source_id, j.attempts, j.created_at
  )
  select updated.id, updated.project_id, updated.source_id, updated.attempts, updated.created_at
  from updated;
end;
$$;

comment on function public.claim_ingest_job(integer, integer, uuid) is
'Claims one queued/stale-running ingest job with skip-locked semantics and lease timeout.';

grant execute on function public.claim_ingest_job(integer, integer, uuid) to service_role;

create or replace function public.replace_source_chunks(
  p_project_id uuid,
  p_source_id uuid,
  p_chunks jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer := 0;
begin
  if p_chunks is null then
    p_chunks := '[]'::jsonb;
  end if;

  if jsonb_typeof(p_chunks) <> 'array' then
    raise exception 'p_chunks must be a JSON array';
  end if;

  with input_rows as (
    select
      (row_value->>'chunk_index')::integer as chunk_index,
      row_value->>'content' as content,
      coalesce(row_value->'metadata', '{}'::jsonb) as metadata,
      (row_value->>'embedding')::vector as embedding
    from jsonb_array_elements(p_chunks) as row_value
  ),
  upserted as (
    insert into public.source_chunks (
      project_id,
      source_id,
      chunk_index,
      content,
      metadata,
      embedding
    )
    select
      p_project_id,
      p_source_id,
      i.chunk_index,
      i.content,
      i.metadata,
      i.embedding
    from input_rows i
    on conflict (source_id, chunk_index)
    do update set
      content = excluded.content,
      metadata = excluded.metadata,
      embedding = excluded.embedding,
      updated_at = now()
    returning 1
  )
  select count(*) into inserted_count from upserted;

  delete from public.source_chunks sc
  where sc.project_id = p_project_id
    and sc.source_id = p_source_id
    and not exists (
      select 1
      from jsonb_array_elements(p_chunks) as row_value
      where (row_value->>'chunk_index')::integer = sc.chunk_index
    );

  return inserted_count;
end;
$$;

comment on function public.replace_source_chunks(uuid, uuid, jsonb) is
'Upserts source chunks for one source and removes stale chunk indexes in one transaction.';

grant execute on function public.replace_source_chunks(uuid, uuid, jsonb) to service_role;

commit;
