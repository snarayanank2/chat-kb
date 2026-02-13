import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { createKeyringFromEnv, toPostgresBytea } from "../_shared/crypto.ts";

const API_VERSION = "v1";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

type OAuthState = {
  user_id: string;
  session_token: string;
  return_to?: string;
};

function json(
  status: number,
  body: Record<string, unknown>,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function buildErrorResponse(
  status: number,
  requestId: string,
  code: string,
  message: string,
  retryable = false,
  details: Record<string, unknown> = {},
) {
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

function redirectToOwner(ownerAppUrl: string, status: "success" | "error", message?: string) {
  const url = new URL(ownerAppUrl);
  url.pathname = "/settings";
  url.searchParams.set("drive_connect", status);
  if (message) {
    url.searchParams.set("reason", message);
  }
  return Response.redirect(url.toString(), 302);
}

function decodeState(rawState: string): OAuthState {
  let parsed: unknown;
  try {
    const padded = rawState.padEnd(rawState.length + (4 - (rawState.length % 4 || 4)) % 4, "=");
    const jsonText = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("Invalid OAuth state payload.");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.user_id !== "string" ||
    typeof parsed.session_token !== "string"
  ) {
    throw new Error("OAuth state payload is missing required fields.");
  }

  return parsed as OAuthState;
}

function extractSubjectFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1];
    const padded = payload.padEnd(payload.length + (4 - (payload.length % 4 || 4)) % 4, "=");
    const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(decoded) as { sub?: unknown };
    if (typeof parsed.sub === "string" && parsed.sub.length > 0) {
      return parsed.sub;
    }
  } catch {
    return null;
  }
  return null;
}

function mapGoogleTokenError(errorCode: string | null): {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
} {
  switch (errorCode) {
    case "invalid_grant":
      return {
        status: 400,
        code: "expired_oauth_code",
        message: "Google authorization code expired or was already used.",
        retryable: true,
      };
    case "invalid_client":
      return {
        status: 500,
        code: "oauth_client_misconfigured",
        message: "Google OAuth client is misconfigured.",
        retryable: false,
      };
    case "access_denied":
      return {
        status: 400,
        code: "consent_revoked",
        message: "Google authorization was denied or revoked.",
        retryable: true,
      };
    default:
      return {
        status: 503,
        code: "provider_unavailable",
        message: "Google OAuth provider is temporarily unavailable.",
        retryable: true,
      };
  }
}

async function fetchGoogleSubject(accessToken: string): Promise<string | null> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (body && typeof body.sub === "string") {
    return body.sub;
  }
  return null;
}

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  const ownerAppUrl = Deno.env.get("OWNER_APP_URL") ?? "http://localhost:5173";

  if (request.method !== "GET") {
    return buildErrorResponse(405, requestId, "method_not_allowed", "Only GET is supported.");
  }

  const googleClientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const googleClientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  const redirectUri = Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (
    !googleClientId ||
    !googleClientSecret ||
    !redirectUri ||
    !supabaseUrl ||
    !supabaseServiceRoleKey ||
    !supabaseAnonKey
  ) {
    return buildErrorResponse(
      500,
      requestId,
      "missing_configuration",
      "Required environment variables are missing.",
    );
  }

  const url = new URL(request.url);
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const mapped = mapGoogleTokenError(oauthError);
    return redirectToOwner(ownerAppUrl, "error", mapped.code);
  }

  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");

  if (!code || !stateParam) {
    return buildErrorResponse(
      400,
      requestId,
      "invalid_request",
      "Missing OAuth callback parameters.",
      false,
      { required: ["code", "state"] },
    );
  }

  let oauthState: OAuthState;
  try {
    oauthState = decodeState(stateParam);
  } catch (error) {
    return buildErrorResponse(
      400,
      requestId,
      "invalid_state",
      error instanceof Error ? error.message : "Invalid OAuth state payload.",
    );
  }

  const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error: userError,
  } = await anonClient.auth.getUser(oauthState.session_token);

  if (userError || !user || user.id !== oauthState.user_id) {
    return buildErrorResponse(
      401,
      requestId,
      "invalid_owner_session",
      "Unable to validate owner session for Drive connection.",
      false,
    );
  }

  const tokenBody = new URLSearchParams({
    code,
    client_id: googleClientId,
    client_secret: googleClientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: tokenBody.toString(),
  });

  const tokenJson = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok) {
    const mapped = mapGoogleTokenError(
      typeof tokenJson?.error === "string" ? tokenJson.error : null,
    );
    return redirectToOwner(ownerAppUrl, "error", mapped.code);
  }

  const refreshToken =
    typeof tokenJson.refresh_token === "string" ? tokenJson.refresh_token : null;
  const accessToken = typeof tokenJson.access_token === "string" ? tokenJson.access_token : null;
  const idToken = typeof tokenJson.id_token === "string" ? tokenJson.id_token : undefined;
  const scopeText = typeof tokenJson.scope === "string" ? tokenJson.scope : "";
  const grantedScopes = scopeText.split(" ").filter(Boolean);

  if (!grantedScopes.includes(DRIVE_FILE_SCOPE)) {
    return redirectToOwner(ownerAppUrl, "error", "insufficient_scopes");
  }

  if (!refreshToken && !accessToken) {
    return redirectToOwner(ownerAppUrl, "error", "oauth_missing_tokens");
  }

  let googleSubject = extractSubjectFromIdToken(idToken);
  if (!googleSubject && accessToken) {
    googleSubject = await fetchGoogleSubject(accessToken);
  }
  if (!googleSubject) {
    return redirectToOwner(ownerAppUrl, "error", "google_identity_unavailable");
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: existingConnection, error: existingError } = await adminClient
    .from("google_connections")
    .select("user_id,refresh_token_ciphertext,nonce,key_version")
    .eq("user_id", oauthState.user_id)
    .maybeSingle();
  if (existingError) {
    return buildErrorResponse(
      500,
      requestId,
      "connection_read_failed",
      "Failed to read existing Google connection state.",
    );
  }

  let refreshTokenCiphertext: string | null = null;
  let nonce: string | null = null;
  let keyVersion: number | null = null;

  if (refreshToken) {
    const keyring = await createKeyringFromEnv(Deno.env.toObject());
    const encrypted = await keyring.encrypt(refreshToken);
    refreshTokenCiphertext = toPostgresBytea(encrypted.ciphertext);
    nonce = toPostgresBytea(encrypted.nonce);
    keyVersion = encrypted.keyVersion;
  } else if (existingConnection) {
    refreshTokenCiphertext = existingConnection.refresh_token_ciphertext;
    nonce = existingConnection.nonce;
    keyVersion = existingConnection.key_version;
  } else {
    return redirectToOwner(ownerAppUrl, "error", "missing_refresh_token");
  }

  const { error: upsertError } = await adminClient.from("google_connections").upsert(
    {
      user_id: oauthState.user_id,
      google_subject: googleSubject,
      refresh_token_ciphertext: refreshTokenCiphertext,
      nonce,
      key_version: keyVersion,
      scopes: grantedScopes,
    },
    { onConflict: "user_id" },
  );

  if (upsertError) {
    return buildErrorResponse(
      500,
      requestId,
      "connection_write_failed",
      "Failed to persist Google connection.",
    );
  }

  return redirectToOwner(ownerAppUrl, "success");
});
