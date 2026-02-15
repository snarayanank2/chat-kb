import type { Session } from "@supabase/supabase-js";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_SCOPES = [DRIVE_FILE_SCOPE].join(" ");

export type SourceType = "gdoc" | "gslides" | "gpdf";

const DOCS_DOCUMENT_PATH = "/document/d/";
const DOCS_PRESENTATION_PATH = "/presentation/d/";
const DRIVE_FILE_PATH = "/file/d/";

/**
 * Extracts a Google Drive file ID from a URL or returns the input if it looks like a raw ID.
 * Supports:
 * - https://drive.google.com/file/d/<id>/...
 * - https://docs.google.com/document/d/<id>/...
 * - https://docs.google.com/presentation/d/<id>/...
 * - raw file ID (alphanumeric, hyphens, underscores; typical length 33–44 chars)
 */
export function extractDriveFileId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const url = new URL(trimmed);
      const path = url.pathname;
      for (const prefix of [DOCS_DOCUMENT_PATH, DOCS_PRESENTATION_PATH, DRIVE_FILE_PATH]) {
        const i = path.indexOf(prefix);
        if (i !== -1) {
          const start = i + prefix.length;
          const rest = path.slice(start);
          const end = rest.indexOf("/");
          const id = end === -1 ? rest : rest.slice(0, end);
          if (id && /^[a-zA-Z0-9_-]+$/.test(id)) return id;
          return null;
        }
      }
      return null;
    }

    if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Infers source type from a Google Docs/Drive URL when possible.
 * - docs.google.com/document -> gdoc
 * - docs.google.com/presentation -> gslides
 * - drive.google.com/file or raw ID -> null (caller must ask user)
 */
export function inferSourceTypeFromUrl(input: string): SourceType | null {
  const trimmed = input.trim();
  if (trimmed.includes("/document/d/")) return "gdoc";
  if (trimmed.includes("/presentation/d/")) return "gslides";
  return null;
}

export function mapMimeTypeToSourceType(mimeType: string): SourceType | null {
  if (mimeType === "application/vnd.google-apps.document") return "gdoc";
  if (mimeType === "application/vnd.google-apps.presentation") return "gslides";
  if (mimeType === "application/pdf") return "gpdf";
  return null;
}

export function sourceTypeToMimeType(sourceType: SourceType): string {
  switch (sourceType) {
    case "gdoc":
      return "application/vnd.google-apps.document";
    case "gslides":
      return "application/vnd.google-apps.presentation";
    case "gpdf":
      return "application/pdf";
  }
}

function encodeState(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function getDriveConnectUrl(session: Session, userId: string): string {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const googleClientId = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID as string | undefined;
  const redirectUri =
    (import.meta.env.VITE_GOOGLE_OAUTH_REDIRECT_URI as string | undefined) ??
    (supabaseUrl ? `${supabaseUrl}/functions/v1/drive_connect` : undefined);

  if (!supabaseUrl || !googleClientId || !redirectUri) {
    throw new Error(
      "Missing Drive OAuth env vars. Set VITE_SUPABASE_URL, VITE_GOOGLE_OAUTH_CLIENT_ID, and VITE_GOOGLE_OAUTH_REDIRECT_URI.",
    );
  }

  const state = encodeState({
    user_id: userId,
    session_token: session.access_token,
    return_to: `${window.location.origin}/settings`,
  });

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", googleClientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("scope", DRIVE_SCOPES);
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return authUrl.toString();
}
