import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const API_VERSION = "v1";
const DEFAULT_MAX_RUNNING_PER_PROJECT = 3;
const DEFAULT_MAX_QUEUED_PER_PROJECT = 100;

type ResyncRequest = {
  project_id?: string;
  source_id?: string;
};

type JsonRecord = Record<string, unknown>;

function json(status: number, body: JsonRecord, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function buildResponse(requestId: string, data: JsonRecord, status = 200): Response {
  return json(status, {
    api_version: API_VERSION,
    request_id: requestId,
    data,
  });
}

function buildError(
  status: number,
  requestId: string,
  code: string,
  message: string,
  retryable = false,
  details: JsonRecord = {},
): Response {
  return json(status, {
    api_version: API_VERSION,
    request_id: requestId,
    error: {
      code,
      message,
      retryable,
      details,
    },
  });
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

function withCors(request: Request, response: Response): Response {
  const origin = request.headers.get("origin") ?? "*";
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "origin");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return withCors(
      request,
      new Response(null, {
        status: 204,
      }),
    );
  }

  const requestId = crypto.randomUUID();
  if (request.method !== "POST") {
    return withCors(
      request,
      buildError(405, requestId, "method_not_allowed", "Only POST is supported."),
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return withCors(
      request,
      buildError(
        500,
        requestId,
        "missing_configuration",
        "Required environment variables are missing.",
      ),
    );
  }

  const maxRunningPerProject = parsePositiveInt(
    Deno.env.get("INGEST_MAX_RUNNING_PER_PROJECT"),
    DEFAULT_MAX_RUNNING_PER_PROJECT,
  );
  const maxQueuedPerProject = parsePositiveInt(
    Deno.env.get("INGEST_MAX_QUEUED_PER_PROJECT"),
    DEFAULT_MAX_QUEUED_PER_PROJECT,
  );

  const bearerToken = extractBearerToken(request);
  if (!bearerToken) {
    return withCors(
      request,
      buildError(401, requestId, "invalid_owner_session", "Missing bearer token."),
    );
  }

  const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user },
    error: userError,
  } = await anonClient.auth.getUser(bearerToken);
  if (userError || !user) {
    return withCors(
      request,
      buildError(
        401,
        requestId,
        "invalid_owner_session",
        "Unable to validate owner session.",
      ),
    );
  }

  let payload: ResyncRequest;
  try {
    payload = (await request.json()) as ResyncRequest;
  } catch {
    return withCors(
      request,
      buildError(400, requestId, "invalid_request", "Request body must be valid JSON."),
    );
  }

  const projectId = typeof payload.project_id === "string" ? payload.project_id : "";
  const sourceId = typeof payload.source_id === "string" ? payload.source_id : null;

  if (!projectId) {
    return withCors(
      request,
      buildError(400, requestId, "invalid_request", "project_id is required."),
    );
  }

  const { data: ownedProject, error: projectError } = await anonClient
    .from("projects")
    .select("id,name")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError) {
    return withCors(
      request,
      buildError(500, requestId, "internal_error", "Failed to load project."),
    );
  }
  if (!ownedProject) {
    return withCors(
      request,
      buildError(404, requestId, "project_not_found", "Project not found."),
    );
  }

  let sourceQuery = anonClient
    .from("project_sources")
    .select("id,title,status,source_type")
    .eq("project_id", projectId);
  if (sourceId) {
    sourceQuery = sourceQuery.eq("id", sourceId);
  }
  const { data: selectedSources, error: sourceError } = await sourceQuery;
  if (sourceError) {
    return withCors(
      request,
      buildError(500, requestId, "internal_error", "Failed to load project sources."),
    );
  }
  if (!selectedSources?.length) {
    return withCors(
      request,
      buildError(404, requestId, "source_not_found", "No matching source found for project."),
    );
  }

  const { count: runningCount, error: runningCountError } = await adminClient
    .from("ingest_jobs")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("status", "running");
  if (runningCountError) {
    return withCors(
      request,
      buildError(
        500,
        requestId,
        "internal_error",
        "Failed to evaluate ingestion concurrency.",
      ),
    );
  }
  if ((runningCount ?? 0) >= maxRunningPerProject) {
    return withCors(
      request,
      buildError(
        409,
        requestId,
        "resync_in_progress",
        "Project has reached max concurrent ingestion jobs.",
        true,
        {
          running_jobs: runningCount ?? 0,
          max_running_jobs: maxRunningPerProject,
        },
      ),
    );
  }

  const { count: queuedCount, error: queuedCountError } = await adminClient
    .from("ingest_jobs")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("status", "queued");
  if (queuedCountError) {
    return withCors(
      request,
      buildError(500, requestId, "internal_error", "Failed to inspect queued jobs."),
    );
  }
  if ((queuedCount ?? 0) >= maxQueuedPerProject) {
    return withCors(
      request,
      buildError(
        409,
        requestId,
        "resync_in_progress",
        "Project has too many queued ingestion jobs.",
        true,
        {
          queued_jobs: queuedCount ?? 0,
          max_queued_jobs: maxQueuedPerProject,
        },
      ),
    );
  }

  const sourceIds = selectedSources.map((row) => row.id);
  const { data: existingJobs, error: existingJobsError } = await adminClient
    .from("ingest_jobs")
    .select("id,source_id,status")
    .eq("project_id", projectId)
    .in("status", ["queued", "running"])
    .in("source_id", sourceIds);
  if (existingJobsError) {
    return withCors(
      request,
      buildError(500, requestId, "internal_error", "Failed to read existing ingest jobs."),
    );
  }

  const sourceIdsWithInFlightJobs = new Set(
    (existingJobs ?? [])
      .map((row) => row.source_id)
      .filter((value): value is string => typeof value === "string"),
  );

  const rowsToInsert = sourceIds
    .filter((id) => !sourceIdsWithInFlightJobs.has(id))
    .map((id) => ({
      project_id: projectId,
      source_id: id,
      status: "queued" as const,
      attempts: 0,
      error: null,
    }));

  let enqueuedJobIds: string[] = [];
  if (rowsToInsert.length > 0) {
    const { data: insertedJobs, error: insertError } = await adminClient
      .from("ingest_jobs")
      .insert(rowsToInsert)
      .select("id");
    if (insertError) {
      return withCors(
        request,
        buildError(500, requestId, "internal_error", "Failed to enqueue ingestion jobs."),
      );
    }
    enqueuedJobIds = (insertedJobs ?? []).map((row) => row.id as string);

    const { error: sourceUpdateError } = await adminClient
      .from("project_sources")
      .update({
        status: "pending",
        error: null,
      })
      .eq("project_id", projectId)
      .in(
        "id",
        rowsToInsert.map((row) => row.source_id),
      );
    if (sourceUpdateError) {
      return withCors(
        request,
        buildError(500, requestId, "internal_error", "Failed to mark sources as pending."),
      );
    }
  }

  await adminClient.from("audit_logs").insert({
    project_id: projectId,
    event_type: "ingestion_started",
    request_id: requestId,
    metadata: {
      function_name: "kb_resync",
      owner_user_id: user.id,
      requested_source_id: sourceId,
      selected_source_count: sourceIds.length,
      enqueued_count: enqueuedJobIds.length,
      skipped_existing_count: sourceIds.length - enqueuedJobIds.length,
    },
  });

  return withCors(
    request,
    buildResponse(requestId, {
      project_id: projectId,
      job_ids: enqueuedJobIds,
      enqueued_count: enqueuedJobIds.length,
      skipped_existing_count: sourceIds.length - enqueuedJobIds.length,
      selected_source_count: sourceIds.length,
    }),
  );
});
