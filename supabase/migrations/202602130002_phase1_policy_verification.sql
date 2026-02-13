do $$
declare
  v_missing_count integer;
begin
  select count(*) into v_missing_count
  from (
    values
      ('public', 'projects_owner_all'),
      ('public', 'google_connections_owner_all'),
      ('public', 'project_sources_owner_all'),
      ('public', 'source_chunks_owner_select'),
      ('public', 'ingest_jobs_owner_select'),
      ('public', 'rate_limit_buckets_owner_select'),
      ('public', 'project_usage_daily_owner_select'),
      ('public', 'project_usage_monthly_owner_select'),
      ('public', 'audit_logs_owner_select')
  ) expected(schema_name, policy_name)
  left join pg_policies p
    on p.schemaname = expected.schema_name
   and p.policyname = expected.policy_name
  where p.policyname is null;

  if v_missing_count > 0 then
    raise exception 'phase1 verification failed: missing % required RLS policies', v_missing_count;
  end if;
end
$$;

do $$
declare
  v_missing_indexes integer;
begin
  select count(*) into v_missing_indexes
  from (
    values
      ('projects_handle_idx'),
      ('project_sources_project_status_idx'),
      ('source_chunks_project_source_idx'),
      ('source_chunks_embedding_cosine_idx'),
      ('ingest_jobs_status_created_idx'),
      ('project_usage_daily_project_date_idx'),
      ('project_usage_monthly_project_month_idx'),
      ('audit_logs_project_timestamp_event_idx')
  ) expected(index_name)
  left join pg_indexes i
    on i.schemaname = 'public'
   and i.indexname = expected.index_name
  where i.indexname is null;

  if v_missing_indexes > 0 then
    raise exception 'phase1 verification failed: missing % required indexes', v_missing_indexes;
  end if;
end
$$;
