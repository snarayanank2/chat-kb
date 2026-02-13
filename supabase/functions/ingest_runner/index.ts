import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { createKeyringFromEnv, fromPostgresBytea } from "../_shared/crypto.ts";

const API_VERSION = "v1";
const GOOGLE_DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

type JsonRecord = Record<string, unknown>;

type JobClaim = {
  id: string;
  project_id: string;
  source_id: string | null;
  attempts: number;
};

type ChunkRow = {
  chunk_index: number;
  content: string;
  metadata: JsonRecord;
};

function json(status: number, body: JsonRecord): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
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

function sanitizeText(value: string): string {
  return value
    .replace(/\u0000/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

function extractPrintableTextFromPdf(bytes: Uint8Array): string {
  const runs: string[] = [];
  let current = "";
  const flush = () => {
    const normalized = current.replace(/\s+/g, " ").trim();
    if (normalized.length >= 24) {
      runs.push(normalized);
    }
    current = "";
  };

  for (const byte of bytes) {
    const isPrintable =
      (byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13;
    if (isPrintable) {
      current += String.fromCharCode(byte);
      continue;
    }
    flush();
  }
  flush();

  return sanitizeText(runs.join("\n"));
}

function estimatePdfPageCount(bytes: Uint8Array): number {
  try {
    const text = new TextDecoder("latin1").decode(bytes);
    const matches = text.match(/\/Type\s*\/Page\b/g);
    return Math.max(1, matches?.length ?? 0);
  } catch {
    return 1;
  }
}

function isLowTextPdf(text: string, minChars: number): boolean {
  const compact = text.replace(/\s+/g, "").trim();
  return compact.length < minChars;
}

function chunkText(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
  maxChunks: number,
): ChunkRow[] {
  const normalized = sanitizeText(text);
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
  const chunks: ChunkRow[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= chunkSize) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push({
        chunk_index: chunks.length,
        content: current,
        metadata: {},
      });
      if (chunks.length >= maxChunks) return chunks;
    }

    if (paragraph.length <= chunkSize) {
      current = paragraph;
      continue;
    }

    let cursor = 0;
    while (cursor < paragraph.length) {
      const slice = paragraph.slice(cursor, cursor + chunkSize);
      chunks.push({
        chunk_index: chunks.length,
        content: slice,
        metadata: {},
      });
      if (chunks.length >= maxChunks) return chunks;
      if (slice.length < chunkSize) break;
      cursor += Math.max(1, chunkSize - chunkOverlap);
    }
    current = "";
  }

  if (current && chunks.length < maxChunks) {
    chunks.push({
      chunk_index: chunks.length,
      content: current,
      metadata: {},
    });
  }

  return chunks;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDriveAccessToken(
  refreshToken: string,
  googleClientId: string,
  googleClientSecret: string,
): Promise<string> {
  const tokenBody = new URLSearchParams({
    client_id: googleClientId,
    client_secret: googleClientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new Error("Failed to refresh Drive access token.");
  }
  return payload.access_token;
}

async function fetchGoogleDocText(accessToken: string, driveFileId: string): Promise<string> {
  const url =
    `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}/export?mimeType=` +
    encodeURIComponent("text/plain");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Drive export failed (${response.status}).`);
  }
  const text = await response.text();
  return sanitizeText(text);
}

async function fetchGoogleSlidesText(accessToken: string, driveFileId: string): Promise<string> {
  const textUrl =
    `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}/export?mimeType=` +
    encodeURIComponent("text/plain");
  const textResponse = await fetch(textUrl, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (textResponse.ok) {
    const text = await textResponse.text();
    const normalized = sanitizeText(text);
    if (normalized.length > 0) return normalized;
  }

  const pdfUrl =
    `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}/export?mimeType=` +
    encodeURIComponent("application/pdf");
  const pdfResponse = await fetch(pdfUrl, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!pdfResponse.ok) {
    throw new Error(`Slides export failed (${pdfResponse.status}).`);
  }
  const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());
  return extractPrintableTextFromPdf(pdfBytes);
}

async function fetchPdfBytes(accessToken: string, driveFileId: string): Promise<Uint8Array> {
  const url = `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}?alt=media`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`PDF download failed (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function extractPdfTextWithOpenAI(
  openAiApiKey: string,
  model: string,
  pdfBytes: Uint8Array,
): Promise<string> {
  const body = {
    model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Extract as much readable text as possible from this PDF. Return plain text only. " +
              "Do not summarize.",
          },
          {
            type: "input_file",
            filename: "source.pdf",
            file_data: `data:application/pdf;base64,${toBase64(pdfBytes)}`,
          },
        ],
      },
    ],
    max_output_tokens: 4000,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${openAiApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error("OpenAI PDF extraction failed.");
  }

  if (typeof payload.output_text === "string" && payload.output_text.trim().length > 0) {
    return sanitizeText(payload.output_text);
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const textParts: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (block?.type === "output_text" && typeof block?.text === "string") {
        textParts.push(block.text);
      }
    }
  }
  return sanitizeText(textParts.join("\n"));
}

async function createEmbeddings(
  openAiApiKey: string,
  model: string,
  contents: string[],
  batchSize: number,
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let index = 0; index < contents.length; index += batchSize) {
    const batch = contents.slice(index, index + batchSize);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${openAiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: batch,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.data)) {
      throw new Error("Embedding generation failed.");
    }

    for (const row of payload.data) {
      if (!Array.isArray(row?.embedding)) {
        throw new Error("Embedding response was missing vector data.");
      }
      embeddings.push(row.embedding as number[]);
    }
  }
  return embeddings;
}

async function markJobDone(
  adminClient: ReturnType<typeof createClient>,
  jobId: string,
): Promise<void> {
  const { error } = await adminClient
    .from("ingest_jobs")
    .update({
      status: "done",
      completed_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", jobId);
  if (error) throw new Error(`Failed to mark job done: ${error.message}`);
}

async function markJobRetryOrFailed(
  adminClient: ReturnType<typeof createClient>,
  job: JobClaim,
  message: string,
  maxAttempts: number,
): Promise<"queued" | "failed"> {
  const shouldRetry = job.attempts < maxAttempts;
  if (shouldRetry) {
    const retryDelayMs = Math.min(5000, 250 * 2 ** Math.max(0, job.attempts - 1));
    await sleep(retryDelayMs);
    const { error } = await adminClient
      .from("ingest_jobs")
      .update({
        status: "queued",
        error: message,
        started_at: null,
      })
      .eq("id", job.id);
    if (error) {
      throw new Error(`Failed to requeue job: ${error.message}`);
    }
    return "queued";
  }

  const { error } = await adminClient
    .from("ingest_jobs")
    .update({
      status: "failed",
      error: message,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);
  if (error) {
    throw new Error(`Failed to mark job failed: ${error.message}`);
  }
  return "failed";
}

async function runSingleJob(
  adminClient: ReturnType<typeof createClient>,
  requestId: string,
  traceId: string,
  env: Record<string, string | undefined>,
  pdfFallbackCounter: { value: number },
): Promise<"processed" | "no_jobs"> {
  const leaseSeconds = parsePositiveInt(env.INGEST_JOB_LEASE_SECONDS, 300);
  const maxAttempts = parsePositiveInt(env.INGEST_MAX_ATTEMPTS, 5);

  const { data: claimedRows, error: claimError } = await adminClient.rpc("claim_ingest_job", {
    p_lease_seconds: leaseSeconds,
    p_max_attempts: maxAttempts,
    p_project_id: null,
  });
  if (claimError) {
    throw new Error(`Failed to claim ingestion job: ${claimError.message}`);
  }

  const claimed = (claimedRows as JobClaim[] | null)?.[0];
  if (!claimed || !claimed.source_id) {
    return "no_jobs";
  }

  const job = claimed;
  try {
    const { data: source, error: sourceError } = await adminClient
      .from("project_sources")
      .select("id,project_id,source_type,drive_file_id,title")
      .eq("id", job.source_id)
      .eq("project_id", job.project_id)
      .maybeSingle();
    if (sourceError || !source) {
      throw new Error("Source not found for ingestion job.");
    }

    const { data: project, error: projectError } = await adminClient
      .from("projects")
      .select("id,owner_user_id,name,max_total_chunks,max_ocr_pages_per_sync")
      .eq("id", job.project_id)
      .maybeSingle();
    if (projectError || !project) {
      throw new Error("Project not found for ingestion job.");
    }

    const { data: connection, error: connectionError } = await adminClient
      .from("google_connections")
      .select("user_id,refresh_token_ciphertext,nonce,key_version")
      .eq("user_id", project.owner_user_id)
      .maybeSingle();
    if (connectionError || !connection) {
      throw new Error("Google Drive connection not found for project owner.");
    }

    await adminClient
      .from("project_sources")
      .update({ status: "processing", error: null })
      .eq("id", source.id)
      .eq("project_id", source.project_id);

    const keyring = await createKeyringFromEnv(env);
    const refreshToken = await keyring.decrypt(
      fromPostgresBytea(connection.refresh_token_ciphertext),
      fromPostgresBytea(connection.nonce),
      connection.key_version,
    );

    const googleClientId = env.GOOGLE_OAUTH_CLIENT_ID;
    const googleClientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!googleClientId || !googleClientSecret) {
      throw new Error("Missing Google OAuth client configuration.");
    }
    const accessToken = await fetchDriveAccessToken(
      refreshToken,
      googleClientId,
      googleClientSecret,
    );

    const minPdfTextChars = parsePositiveInt(env.PDF_LOW_TEXT_MIN_CHARS, 600);
    const maxPdfBytes = parsePositiveInt(env.PDF_MAX_BYTES_PER_FILE, 10 * 1024 * 1024);
    const maxPdfFallbacks = parsePositiveInt(env.PDF_MAX_FALLBACKS_PER_RUN, 2);
    const openAiApiKey = env.OPENAI_API_KEY;
    const openAiPdfModel = env.OPENAI_PDF_EXTRACTION_MODEL ?? "gpt-4.1-mini";

    let extractedText = "";
    let extractionStrategy = "drive_export_text";

    if (source.source_type === "gdoc") {
      extractedText = await fetchGoogleDocText(accessToken, source.drive_file_id);
    } else if (source.source_type === "gslides") {
      extractedText = await fetchGoogleSlidesText(accessToken, source.drive_file_id);
    } else {
      const pdfBytes = await fetchPdfBytes(accessToken, source.drive_file_id);
      if (pdfBytes.byteLength > maxPdfBytes) {
        throw new Error("PDF exceeds configured max size for ingestion.");
      }
      extractedText = extractPrintableTextFromPdf(pdfBytes);
      extractionStrategy = "pdf_baseline";
      const estimatedPdfPages = estimatePdfPageCount(pdfBytes);

      const lowText = isLowTextPdf(extractedText, minPdfTextChars);
      if (
        lowText &&
        openAiApiKey &&
        pdfFallbackCounter.value < maxPdfFallbacks &&
        estimatedPdfPages <= project.max_ocr_pages_per_sync
      ) {
        const fallbackText = await extractPdfTextWithOpenAI(
          openAiApiKey,
          openAiPdfModel,
          pdfBytes,
        );
        if (fallbackText.length > extractedText.length) {
          extractedText = fallbackText;
          extractionStrategy = "pdf_openai_fallback";
        }
        pdfFallbackCounter.value += 1;
      } else if (lowText && estimatedPdfPages > project.max_ocr_pages_per_sync) {
        extractionStrategy = "pdf_baseline_ocr_cap_enforced";
        await adminClient.from("audit_logs").insert({
          project_id: source.project_id,
          event_type: "ingestion_guardrail_enforced",
          request_id: requestId,
          metadata: {
            schema_version: 1,
            function_name: "ingest_runner",
            trace_id: traceId,
            guardrail: "max_ocr_pages_per_sync",
            max_ocr_pages_per_sync: project.max_ocr_pages_per_sync,
            estimated_pdf_pages: estimatedPdfPages,
            source_id: source.id,
          },
        });
      }
    }

    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error("No extractable text found for source.");
    }

    const chunkSize = parsePositiveInt(env.INGEST_CHUNK_SIZE_CHARS, 1200);
    const chunkOverlap = parsePositiveInt(env.INGEST_CHUNK_OVERLAP_CHARS, 200);
    const maxChunks = parsePositiveInt(env.INGEST_MAX_CHUNKS_PER_SOURCE, 300);
    const { count: existingChunkCount, error: existingChunkCountError } = await adminClient
      .from("source_chunks")
      .select("id", { count: "exact", head: true })
      .eq("project_id", source.project_id)
      .neq("source_id", source.id);
    if (existingChunkCountError) {
      throw new Error("Failed to evaluate project chunk cap.");
    }
    const remainingProjectChunkBudget = Math.max(
      0,
      project.max_total_chunks - (existingChunkCount ?? 0),
    );
    if (remainingProjectChunkBudget <= 0) {
      throw new Error("Project reached max_total_chunks cap.");
    }
    const effectiveMaxChunks = Math.min(maxChunks, remainingProjectChunkBudget);
    const chunks = chunkText(extractedText, chunkSize, chunkOverlap, effectiveMaxChunks);
    if (chunks.length === 0) {
      throw new Error("Chunking yielded no content.");
    }
    if (effectiveMaxChunks < maxChunks) {
      await adminClient.from("audit_logs").insert({
        project_id: source.project_id,
        event_type: "ingestion_guardrail_enforced",
        request_id: requestId,
        metadata: {
          schema_version: 1,
          function_name: "ingest_runner",
          trace_id: traceId,
          guardrail: "max_total_chunks",
          max_total_chunks: project.max_total_chunks,
          existing_chunks_other_sources: existingChunkCount ?? 0,
          effective_max_chunks_for_source: effectiveMaxChunks,
          source_id: source.id,
        },
      });
    }

    if (!openAiApiKey) {
      throw new Error("Missing OPENAI_API_KEY for embeddings.");
    }
    const embeddingModel = env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
    const embeddingBatchSize = parsePositiveInt(env.OPENAI_EMBEDDING_BATCH_SIZE, 64);
    const embeddings = await createEmbeddings(
      openAiApiKey,
      embeddingModel,
      chunks.map((row) => row.content),
      embeddingBatchSize,
    );

    const preparedChunkRows = chunks.map((chunk, index) => ({
      chunk_index: chunk.chunk_index,
      content: chunk.content,
      metadata: {
        title: source.title,
        file_id: source.drive_file_id,
        source_type: source.source_type,
        citation_anchor: source.source_type === "gpdf" ? "page_unknown" : "document",
        extraction_strategy: extractionStrategy,
      },
      embedding: toVectorLiteral(embeddings[index]),
    }));

    const { error: replaceError } = await adminClient.rpc("replace_source_chunks", {
      p_project_id: source.project_id,
      p_source_id: source.id,
      p_chunks: preparedChunkRows,
    });
    if (replaceError) {
      throw new Error(`Failed to persist chunks: ${replaceError.message}`);
    }

    const { error: sourceReadyError } = await adminClient
      .from("project_sources")
      .update({
        status: "ready",
        error: null,
        last_ingested_at: new Date().toISOString(),
      })
      .eq("id", source.id)
      .eq("project_id", source.project_id);
    if (sourceReadyError) {
      throw new Error(`Failed to mark source ready: ${sourceReadyError.message}`);
    }

    await markJobDone(adminClient, job.id);

    await adminClient.from("audit_logs").insert({
      project_id: source.project_id,
      event_type: "ingestion_completed",
      request_id: requestId,
      metadata: {
        schema_version: 1,
        function_name: "ingest_runner",
        trace_id: traceId,
        status: "done",
        source_id: source.id,
        source_type: source.source_type,
        chunk_count: chunks.length,
        extraction_strategy: extractionStrategy,
        job_id: job.id,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown ingestion error.";
    const retryState = await markJobRetryOrFailed(adminClient, job, errorMessage, maxAttempts);
    await adminClient
      .from("project_sources")
      .update({
        status: "failed",
        error: errorMessage.slice(0, 500),
      })
      .eq("id", job.source_id)
      .eq("project_id", job.project_id);

    await adminClient.from("audit_logs").insert({
      project_id: job.project_id,
      event_type: "ingestion_failed",
      request_id: requestId,
      metadata: {
        schema_version: 1,
        function_name: "ingest_runner",
        trace_id: traceId,
        status: retryState,
        source_id: job.source_id,
        error: errorMessage,
        job_id: job.id,
        attempts: job.attempts,
        max_attempts: maxAttempts,
      },
    });
  }

  return "processed";
}

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  const traceId =
    request.headers.get("x-trace-id")?.trim() ||
    request.headers.get("x-request-id")?.trim() ||
    requestId;
  if (request.method !== "POST") {
    return buildError(405, requestId, "method_not_allowed", "Only POST is supported.");
  }

  const env = Deno.env.toObject();
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return buildError(
      500,
      requestId,
      "missing_configuration",
      "Required environment variables are missing.",
    );
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const maxJobsPerRun = parsePositiveInt(env.INGEST_RUNNER_MAX_JOBS_PER_INVOCATION, 1);
  const pdfFallbackCounter = { value: 0 };
  let processedJobs = 0;

  for (let index = 0; index < maxJobsPerRun; index += 1) {
    const state = await runSingleJob(adminClient, requestId, traceId, env, pdfFallbackCounter);
    if (state === "no_jobs") break;
    processedJobs += 1;
  }

  return buildResponse(requestId, {
    processed_jobs: processedJobs,
    pdf_fallbacks_used: pdfFallbackCounter.value,
  }, 200);
});
