interface Env {
  INGEST_RUNNER_URL: string;
  INGEST_RUNNER_TIMEOUT_MS?: string;
}

const DEFAULT_TIMEOUT_MS = 25000;

function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, 60000);
}

async function triggerIngestRunner(env: Env): Promise<Response> {
  if (!env.INGEST_RUNNER_URL) {
    throw new Error("Missing INGEST_RUNNER_URL.");
  }

  const controller = new AbortController();
  const timeoutMs = parseTimeoutMs(env.INGEST_RUNNER_TIMEOUT_MS);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(env.INGEST_RUNNER_URL, {
      method: "POST",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const response = await triggerIngestRunner(env);
          const body = await response.text();
          if (!response.ok) {
            console.error("ingest_runner failed", {
              status: response.status,
              body,
            });
            return;
          }
          console.log("ingest_runner triggered", {
            status: response.status,
            body,
          });
        } catch (error) {
          console.error("ingest_runner trigger error", error);
        }
      })(),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/trigger") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const response = await triggerIngestRunner(env);
      const body = await response.text();
      return new Response(
        JSON.stringify({
          ok: response.ok,
          status: response.status,
          ingest_runner_response: body,
        }),
        {
          status: response.ok ? 200 : 502,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      return new Response(
        JSON.stringify({
          ok: false,
          error: message,
        }),
        {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
  },
};
