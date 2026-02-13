import type { Session } from "@supabase/supabase-js";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const PICKER_SCOPES = [DRIVE_FILE_SCOPE].join(" ");

export type GooglePickerDocument = {
  id: string;
  name: string;
  mimeType: string;
  url?: string;
};

type PickerCallbackPayload = {
  action?: string;
  docs?: Array<Record<string, unknown>>;
};

type DocsViewInstance = {
  setIncludeFolders: (value: boolean) => DocsViewInstance;
  setSelectFolderEnabled: (value: boolean) => DocsViewInstance;
  setMimeTypes: (value: string) => DocsViewInstance;
};

type PickerInstance = { setVisible: (value: boolean) => void };

type PickerBuilderInstance = {
  addView: (view: DocsViewInstance) => PickerBuilderInstance;
  setOAuthToken: (token: string) => PickerBuilderInstance;
  setDeveloperKey: (value: string) => PickerBuilderInstance;
  setAppId: (value: string) => PickerBuilderInstance;
  setCallback: (callback: (payload: PickerCallbackPayload) => void) => PickerBuilderInstance;
  build: () => PickerInstance;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: string }) => void;
          }) => {
            requestAccessToken: (options?: { prompt?: string }) => void;
          };
        };
      };
      picker?: {
        Action: { PICKED: string };
        DocsView: new () => DocsViewInstance;
        PickerBuilder: new () => PickerBuilderInstance;
        Document: {
          ID: string;
          NAME: string;
          MIME_TYPE: string;
          URL: string;
        };
      };
    };
    gapi?: {
      load: (feature: string, callback: () => void) => void;
    };
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
  authUrl.searchParams.set("scope", PICKER_SCOPES);
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return authUrl.toString();
}

export function mapMimeTypeToSourceType(mimeType: string): "gdoc" | "gslides" | "gpdf" | null {
  if (mimeType === "application/vnd.google-apps.document") {
    return "gdoc";
  }
  if (mimeType === "application/vnd.google-apps.presentation") {
    return "gslides";
  }
  if (mimeType === "application/pdf") {
    return "gpdf";
  }
  return null;
}

let scriptLoadPromise: Promise<void> | null = null;

export function loadGooglePickerDependencies(): Promise<void> {
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise((resolve, reject) => {
    const ensureScript = (src: string, id: string) =>
      new Promise<void>((scriptResolve, scriptReject) => {
        const existing = document.getElementById(id) as HTMLScriptElement | null;
        if (existing) {
          if (existing.dataset.loaded === "true") {
            scriptResolve();
            return;
          }
          existing.addEventListener("load", () => scriptResolve(), { once: true });
          existing.addEventListener("error", () => scriptReject(new Error(`Failed loading ${src}`)), {
            once: true,
          });
          return;
        }

        const script = document.createElement("script");
        script.id = id;
        script.src = src;
        script.async = true;
        script.defer = true;
        script.addEventListener("load", () => {
          script.dataset.loaded = "true";
          scriptResolve();
        });
        script.addEventListener("error", () => scriptReject(new Error(`Failed loading ${src}`)));
        document.head.appendChild(script);
      });

    Promise.all([
      ensureScript("https://apis.google.com/js/api.js", "google-api-script"),
      ensureScript("https://accounts.google.com/gsi/client", "google-gsi-script"),
    ])
      .then(() => resolve())
      .catch(reject);
  });

  return scriptLoadPromise;
}

export async function pickDriveDocuments(): Promise<GooglePickerDocument[]> {
  const pickerApiKey = import.meta.env.VITE_GOOGLE_PICKER_API_KEY as string | undefined;
  const googleClientId = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID as string | undefined;
  const projectNumber = import.meta.env
    .VITE_GOOGLE_CLOUD_PROJECT_NUMBER as string | undefined;

  if (!pickerApiKey || !googleClientId || !projectNumber) {
    throw new Error(
      "Missing picker env vars. Set VITE_GOOGLE_PICKER_API_KEY, VITE_GOOGLE_OAUTH_CLIENT_ID, and VITE_GOOGLE_CLOUD_PROJECT_NUMBER.",
    );
  }

  await loadGooglePickerDependencies();

  const picker = window.google?.picker;
  const gapi = window.gapi;
  const oauth2 = window.google?.accounts?.oauth2;

  if (!picker || !gapi || !oauth2) {
    throw new Error("Google Picker dependencies did not initialize correctly.");
  }

  const accessToken = await new Promise<string>((resolve, reject) => {
    const tokenClient = oauth2.initTokenClient({
      client_id: googleClientId,
      scope: PICKER_SCOPES,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error ?? "Failed to get picker access token."));
          return;
        }
        resolve(response.access_token);
      },
    });
    tokenClient.requestAccessToken({ prompt: "" });
  });

  await new Promise<void>((resolve) => gapi.load("picker", () => resolve()));

  return await new Promise<GooglePickerDocument[]>((resolve) => {
    const docsView = new picker.DocsView()
      .setIncludeFolders(false)
      .setSelectFolderEnabled(false)
      .setMimeTypes(
        [
          "application/vnd.google-apps.document",
          "application/vnd.google-apps.presentation",
          "application/pdf",
        ].join(","),
      );

    const pickerInstance = new picker.PickerBuilder()
      .addView(docsView)
      .setOAuthToken(accessToken)
      .setDeveloperKey(pickerApiKey)
      .setAppId(projectNumber)
      .setCallback((payload) => {
        if (payload.action !== picker.Action.PICKED || !payload.docs) {
          resolve([]);
          return;
        }
        const selected = payload.docs
          .map((doc) => ({
            id: String(doc[picker.Document.ID] ?? ""),
            name: String(doc[picker.Document.NAME] ?? ""),
            mimeType: String(doc[picker.Document.MIME_TYPE] ?? ""),
            url: doc[picker.Document.URL] ? String(doc[picker.Document.URL]) : undefined,
          }))
          .filter((doc) => doc.id && doc.mimeType);
        resolve(selected);
      })
      .build();

    pickerInstance.setVisible(true);
  });
}
