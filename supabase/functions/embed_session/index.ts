import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const API_VERSION = "v1";
const TOKEN_TTL_SECONDS_DEFAULT = 300;
const TOKEN_TTL_SECONDS_MAX = 3600;

type JsonRecord = Record<string, unknown>;

type SessionRequest = {
  project_handle?: string;
};

type ProjectRow = {
  id: string;
  handle: string;
  allowed_origins: string[];
};

type EmbedTokenPayload = {
  v: 1;
  project_id: string;
  project_handle: string;
  origin: string;
  iat: number;
  exp: number;
  jti: string;
};

function json(status: number, body: JsonRecord, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function buildResponse(requestId: string, data: JsonRecord, status = 200, headers?: HeadersInit): Response {
  return json(status, {
    api_version: API_VERSION,
    request_id: requestId,
    data,
  }, {
    "x-request-id": requestId,
    ...headers,
  });
}

function buildError(
  status: number,
  requestId: string,
  code: string,
  message: string,
  retryable = false,
  details: JsonRecord = {},
  headers?: HeadersInit,
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
  }, {
    "x-request-id": requestId,
    ...headers,
  });
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeHex(bytes: ArrayBuffer): string {
  const values = new Uint8Array(bytes);
  let output = "";
  for (const value of values) {
    output += value.toString(16).padStart(2, "0");
  }
  return output;
}

async function signPayload(payload: EmbedTokenPayload, secret: string): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = toBase64Url(encodeUtf8(payloadJson));
  const key = await crypto.subtle.importKey(
    "raw",
    encodeUtf8(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encodeUtf8(payloadB64));
  const signatureB64 = toBase64Url(new Uint8Array(signature));
  return `${payloadB64}.${signatureB64}`;
}

function canonicalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" &&
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "[::1]"
    ) {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function extractClientIp(request: Request): string | null {
  const direct = request.headers.get("cf-connecting-ip");
  if (direct && direct.trim()) {
    return direct.trim();
  }
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const first = forwarded.split(",")[0]?.trim();
  return first || null;
}

async function hashIp(ip: string | null): Promise<string | null> {
  if (!ip) return null;
  const digest = await crypto.subtle.digest("SHA-256", encodeUtf8(ip));
  return decodeHex(digest);
}

function withCors(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  const headers = new Headers(response.headers);
  headers.set("vary", "origin");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  if (origin) {
    headers.set("access-control-allow-origin", origin);
  } else {
    headers.set("access-control-allow-origin", "*");
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

async function insertAuditEvent(
  adminClient: ReturnType<typeof createClient>,
  projectId: string,
  eventType: "embed_session_created" | "blocked_origin",
  request: Request,
  requestId: string,
  traceId: string,
  metadata: JsonRecord,
) {
  try {
    const ipHash = await hashIp(extractClientIp(request));
    const userAgent = request.headers.get("user-agent");
    const origin = request.headers.get("origin");
    await adminClient.from("audit_logs").insert({
      project_id: projectId,
      event_type: eventType,
      origin,
      ip_hash: ipHash,
      user_agent: userAgent,
      request_id: requestId,
      metadata: {
        schema_version: 1,
        function_name: "embed_session",
        trace_id: traceId,
        ...metadata,
      },
    });
  } catch {
    // Keep session flow available even if audit insert fails.
  }
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
  const traceId =
    request.headers.get("x-trace-id")?.trim() ||
    request.headers.get("x-request-id")?.trim() ||
    requestId;
  if (request.method !== "POST") {
    return withCors(
      request,
      buildError(405, requestId, "method_not_allowed", "Only POST is supported."),
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const embedTokenSigningSecret = Deno.env.get("EMBED_TOKEN_SIGNING_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !embedTokenSigningSecret) {
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

  const ttlSeconds = Math.min(
    parsePositiveInt(Deno.env.get("EMBED_TOKEN_TTL_SECONDS"), TOKEN_TTL_SECONDS_DEFAULT),
    TOKEN_TTL_SECONDS_MAX,
  );

  let payload: SessionRequest;
  try {
    payload = (await request.json()) as SessionRequest;
  } catch {
    return withCors(
      request,
      buildError(400, requestId, "invalid_request", "Request body must be valid JSON."),
    );
  }

  const projectHandle =
    typeof payload.project_handle === "string" ? payload.project_handle.trim().toLowerCase() : "";
  if (!projectHandle) {
    return withCors(
      request,
      buildError(400, requestId, "invalid_request", "project_handle is required."),
    );
  }

  const requestOrigin = request.headers.get("origin");
  const normalizedRequestOrigin = requestOrigin ? canonicalizeOrigin(requestOrigin) : null;
  if (!requestOrigin || !normalizedRequestOrigin) {
    return withCors(
      request,
      buildError(
        400,
        requestId,
        "invalid_origin_format",
        "A valid request Origin header is required.",
      ),
    );
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: projectData, error: projectError } = await adminClient
    .from("projects")
    .select("id,handle,allowed_origins")
    .eq("handle", projectHandle)
    .maybeSingle();

  const project = (projectData ?? null) as ProjectRow | null;

  if (projectError) {
    return withCors(
      request,
      buildError(500, requestId, "internal_error", "Failed to resolve project."),
    );
  }
  if (!project) {
    return withCors(
      request,
      buildError(404, requestId, "project_not_found", "Project not found."),
    );
  }

  const allowedOriginSet = new Set(
    (project.allowed_origins ?? [])
      .map((value) => canonicalizeOrigin(value))
      .filter((value): value is string => typeof value === "string"),
  );

  if (!allowedOriginSet.has(normalizedRequestOrigin)) {
    await insertAuditEvent(adminClient, project.id, "blocked_origin", request, requestId, traceId, {
      status: "blocked",
      origin: normalizedRequestOrigin,
      project_handle: project.handle,
      error_code: "blocked_origin",
    });
    return withCors(
      request,
      buildError(
        403,
        requestId,
        "blocked_origin",
        "This chat is not enabled for this website.",
        false,
        {
          project_handle: project.handle,
        },
        {
          "x-trace-id": traceId,
        },
      ),
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = nowSeconds + ttlSeconds;
  const tokenPayload: EmbedTokenPayload = {
    v: 1,
    project_id: project.id,
    project_handle: project.handle,
    origin: normalizedRequestOrigin,
    iat: nowSeconds,
    exp: expiresAtSeconds,
    jti: crypto.randomUUID(),
  };

  const embedToken = await signPayload(tokenPayload, embedTokenSigningSecret);
  const expiresAtIso = new Date(expiresAtSeconds * 1000).toISOString();

  await insertAuditEvent(adminClient, project.id, "embed_session_created", request, requestId, traceId, {
    status: "issued",
    origin: normalizedRequestOrigin,
    project_handle: project.handle,
    ttl_seconds: ttlSeconds,
  });

  return withCors(
    request,
    buildResponse(requestId, {
      embed_token: embedToken,
      expires_at: expiresAtIso,
      project_handle: project.handle,
    }, 200, {
      "x-trace-id": traceId,
    }),
  );
});
