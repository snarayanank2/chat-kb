import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  extractDriveFileId,
  getDriveConnectUrl,
  inferSourceTypeFromUrl,
  sourceTypeToMimeType,
  type SourceType,
} from "../lib/drive";
import { supabase } from "../lib/supabase";
import { parseOrigins, validateOrigins } from "../lib/validation";
import { useAuth } from "../state/AuthContext";
import type {
  AuditLogRow,
  GoogleConnectionRow,
  ProjectRow,
  ProjectSourceRow,
  UsageDailyRow,
  UsageMonthlyRow,
} from "../types/database";

const HIGH_SIGNAL_EVENTS = [
  "blocked_origin",
  "rate_limited",
  "quota_exceeded",
  "ingestion_failed",
  "validation_failed",
];

export function ProjectSettingsPage() {
  const { session, user } = useAuth();
  const params = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const projectId = params.projectId;

  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [originsInput, setOriginsInput] = useState("");
  const [sourceRows, setSourceRows] = useState<ProjectSourceRow[]>([]);
  const [connection, setConnection] = useState<GoogleConnectionRow | null>(null);
  const [dailyUsage, setDailyUsage] = useState<UsageDailyRow[]>([]);
  const [monthlyUsage, setMonthlyUsage] = useState<UsageMonthlyRow[]>([]);
  const [auditRows, setAuditRows] = useState<AuditLogRow[]>([]);
  const [selectedEventFilters, setSelectedEventFilters] = useState<string[]>(
    HIGH_SIGNAL_EVENTS,
  );
  const [driveConnecting, setDriveConnecting] = useState(false);
  const [addSourceLoading, setAddSourceLoading] = useState(false);
  const [sourceActionLoadingId, setSourceActionLoadingId] = useState<string | null>(null);
  const [newSourceInput, setNewSourceInput] = useState("");
  const [newSourceType, setNewSourceType] = useState<SourceType>("gdoc");
  const [newSourceTitle, setNewSourceTitle] = useState("");

  const [form, setForm] = useState({
    rate_rpm: 60,
    rate_burst: 20,
    quota_daily_requests: 1000,
    quota_monthly_requests: 20000,
    quota_daily_tokens: "",
    quota_monthly_tokens: "",
    input_validation_prompt: "",
    output_validation_prompt: "",
  });

  const sourceStatusCounts = useMemo(() => {
    return sourceRows.reduce(
      (acc, row) => {
        acc[row.status] += 1;
        return acc;
      },
      { pending: 0, processing: 0, ready: 0, failed: 0 },
    );
  }, [sourceRows]);

  const loadProjects = async () => {
    const { data, error: queryError } = await supabase
      .from("projects")
      .select("*")
      .order("created_at", { ascending: false });
    if (queryError) throw queryError;
    return data ?? [];
  };

  const loadDriveConnection = async () => {
    const { data, error: queryError } = await supabase
      .from("google_connections")
      .select("user_id,google_subject,scopes,created_at,updated_at")
      .maybeSingle();
    if (queryError) throw queryError;
    setConnection(data ?? null);
  };

  const hydrateProject = (value: ProjectRow) => {
    setProject(value);
    setOriginsInput(value.allowed_origins.join("\n"));
    setForm({
      rate_rpm: value.rate_rpm,
      rate_burst: value.rate_burst,
      quota_daily_requests: value.quota_daily_requests,
      quota_monthly_requests: value.quota_monthly_requests,
      quota_daily_tokens: value.quota_daily_tokens?.toString() ?? "",
      quota_monthly_tokens: value.quota_monthly_tokens?.toString() ?? "",
      input_validation_prompt: value.input_validation_prompt,
      output_validation_prompt: value.output_validation_prompt,
    });
  };

  const loadObservability = async (targetProjectId: string) => {
    const [
      { data: sourceData, error: sourceError },
      { data: dailyData, error: dailyError },
      { data: monthlyData, error: monthlyError },
    ] = await Promise.all([
      supabase
        .from("project_sources")
        .select(
          "id,project_id,source_type,drive_file_id,mime_type,title,status,error,created_at,updated_at",
        )
        .eq("project_id", targetProjectId)
        .order("updated_at", { ascending: false }),
      supabase
        .from("project_usage_daily")
        .select("project_id,usage_date,requests,tokens_in,tokens_out")
        .eq("project_id", targetProjectId)
        .order("usage_date", { ascending: false })
        .limit(14),
      supabase
        .from("project_usage_monthly")
        .select("project_id,month_start,requests,tokens_in,tokens_out")
        .eq("project_id", targetProjectId)
        .order("month_start", { ascending: false })
        .limit(12),
    ]);

    if (sourceError) throw sourceError;
    if (dailyError) throw dailyError;
    if (monthlyError) throw monthlyError;

    setSourceRows(sourceData ?? []);
    setDailyUsage(dailyData ?? []);
    setMonthlyUsage(monthlyData ?? []);
  };

  const loadAuditSummary = async (targetProjectId: string, events: string[]) => {
    const query = supabase
      .from("audit_logs")
      .select("id,project_id,event_type,request_id,created_at,origin")
      .eq("project_id", targetProjectId)
      .order("created_at", { ascending: false })
      .limit(50);

    const { data, error: queryError } =
      events.length > 0 ? await query.in("event_type", events) : await query;

    if (queryError) throw queryError;
    setAuditRows(data ?? []);
  };

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        const [allProjects] = await Promise.all([loadProjects(), loadDriveConnection()]);
        if (cancelled) return;
        setProjects(allProjects);
        if (!allProjects.length) {
          setProject(null);
          setLoading(false);
          return;
        }

        let selected = allProjects.find((row) => row.id === projectId) ?? allProjects[0];
        if (!projectId || selected.id !== projectId) {
          navigate(`/projects/${selected.id}/settings`, { replace: true });
        }

        hydrateProject(selected);
        await loadObservability(selected.id);
        await loadAuditSummary(selected.id, selectedEventFilters);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load settings.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const driveConnectStatus = url.searchParams.get("drive_connect");
    const reason = url.searchParams.get("reason");
    if (!driveConnectStatus) return;

    if (driveConnectStatus === "success") {
      setNotice("Google Drive connected successfully.");
      void loadDriveConnection().catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to refresh Drive connection.");
      });
    } else {
      setError(`Drive connection failed${reason ? ` (${reason})` : "."}`);
    }

    url.searchParams.delete("drive_connect");
    url.searchParams.delete("reason");
    window.history.replaceState({}, "", url);
  }, []);

  useEffect(() => {
    if (!project?.id) return;
    void loadAuditSummary(project.id, selectedEventFilters).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Failed to load audit summary.");
    });
  }, [selectedEventFilters, project?.id]);

  useEffect(() => {
    const inferred = inferSourceTypeFromUrl(newSourceInput);
    if (inferred) setNewSourceType(inferred);
  }, [newSourceInput]);

  const updateProjectSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!project) return;

    const origins = parseOrigins(originsInput);
    const originErrors = validateOrigins(origins);
    if (originErrors.length > 0) {
      setError(originErrors[0]);
      return;
    }

    const payload = {
      allowed_origins: origins,
      rate_rpm: form.rate_rpm,
      rate_burst: form.rate_burst,
      quota_daily_requests: form.quota_daily_requests,
      quota_monthly_requests: form.quota_monthly_requests,
      quota_daily_tokens: form.quota_daily_tokens
        ? Number(form.quota_daily_tokens)
        : null,
      quota_monthly_tokens: form.quota_monthly_tokens
        ? Number(form.quota_monthly_tokens)
        : null,
      input_validation_prompt: form.input_validation_prompt,
      output_validation_prompt: form.output_validation_prompt,
    };

    if (
      payload.quota_daily_tokens !== null &&
      (!Number.isFinite(payload.quota_daily_tokens) || payload.quota_daily_tokens <= 0)
    ) {
      setError("Daily token quota must be a positive number or empty.");
      return;
    }
    if (
      payload.quota_monthly_tokens !== null &&
      (!Number.isFinite(payload.quota_monthly_tokens) ||
        payload.quota_monthly_tokens <= 0)
    ) {
      setError("Monthly token quota must be a positive number or empty.");
      return;
    }

    setSaving(true);
    setError(null);

    const { data, error: updateError } = await supabase
      .from("projects")
      .update(payload)
      .eq("id", project.id)
      .select("*")
      .single();

    setSaving(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }

    hydrateProject(data);
  };

  const toggleEventFilter = (eventType: string) => {
    setSelectedEventFilters((current) =>
      current.includes(eventType)
        ? current.filter((item) => item !== eventType)
        : [...current, eventType],
    );
  };

  const connectDrive = () => {
    if (!session || !user) {
      setError("You must be logged in to connect Google Drive.");
      return;
    }

    setDriveConnecting(true);
    try {
      const connectUrl = getDriveConnectUrl(session, user.id);
      window.location.assign(connectUrl);
    } catch (err) {
      setDriveConnecting(false);
      setError(err instanceof Error ? err.message : "Failed to start Drive OAuth flow.");
    }
  };

  const addSourceFromManualEntry = async (event: FormEvent) => {
    event.preventDefault();
    if (!project) return;
    if (!connection) {
      setError("Connect Google Drive first before adding sources.");
      return;
    }

    const fileId = extractDriveFileId(newSourceInput);
    if (!fileId) {
      setError("Enter a valid Google Drive URL or file ID (e.g. docs.google.com/document/d/... or drive.google.com/file/d/...).");
      return;
    }

    const inferredType = inferSourceTypeFromUrl(newSourceInput);
    const sourceType = inferredType ?? newSourceType;
    const mimeType = sourceTypeToMimeType(sourceType);
    const title = newSourceTitle.trim() || fileId;

    setError(null);
    setNotice(null);
    setAddSourceLoading(true);

    try {
      const { data: existing, error: existingError } = await supabase
        .from("project_sources")
        .select("drive_file_id")
        .eq("project_id", project.id)
        .eq("drive_file_id", fileId);

      if (existingError) throw existingError;
      if ((existing ?? []).length > 0) {
        setError("This file is already attached to this project.");
        setAddSourceLoading(false);
        return;
      }

      const { error: insertError } = await supabase.from("project_sources").insert({
        project_id: project.id,
        source_type: sourceType,
        drive_file_id: fileId,
        mime_type: mimeType,
        title,
        status: "pending",
      });

      if (insertError) {
        if ((insertError as { code?: string }).code === "23505") {
          setError("This file is already attached to this project.");
          return;
        }
        throw insertError;
      }

      setNewSourceInput("");
      setNewSourceTitle("");
      await loadObservability(project.id);
      setNotice("Source added as pending.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add Drive source.");
    } finally {
      setAddSourceLoading(false);
    }
  };

  const removeSource = async (source: ProjectSourceRow) => {
    if (!project) return;
    const ok = window.confirm(`Remove source "${source.title || source.drive_file_id}"?`);
    if (!ok) return;

    setSourceActionLoadingId(source.id);
    setError(null);
    setNotice(null);
    const { error: deleteError } = await supabase
      .from("project_sources")
      .delete()
      .eq("project_id", project.id)
      .eq("id", source.id);
    setSourceActionLoadingId(null);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }

    await loadObservability(project.id);
    setNotice("Source removed.");
  };

  const triggerResync = async (source: ProjectSourceRow) => {
    if (!project) return;
    setSourceActionLoadingId(source.id);
    setError(null);
    setNotice(null);

    const { error: invokeError } = await supabase.functions.invoke("kb_resync", {
      body: { project_id: project.id, source_id: source.id },
    });
    setSourceActionLoadingId(null);

    if (invokeError) {
      setError(invokeError.message);
      return;
    }

    setNotice(`Re-sync requested for "${source.title || source.drive_file_id}".`);
  };

  if (loading) {
    return <p className="state-text">Loading project settings...</p>;
  }

  if (!project) {
    return (
      <section className="panel">
        <h1>Settings</h1>
        <p className="muted">Create a project first to configure it.</p>
        <Link to="/projects">Go to projects</Link>
      </section>
    );
  }

  return (
    <div className="stack">
      <section className="panel">
        <h1>Project settings</h1>
        <div className="status-row">
          <span
            className={`status-pill ${
              connection ? "status-ready" : "status-pending"
            }`}
          >
            Drive: {connection ? "connected" : "not connected"}
          </span>
          <button type="button" onClick={connectDrive} disabled={driveConnecting}>
            {driveConnecting
              ? "Redirecting..."
              : connection
                ? "Reconnect Drive"
                : "Connect Drive"}
          </button>
        </div>
        {connection ? (
          <form className="add-source-form" onSubmit={addSourceFromManualEntry}>
            <label>
              <span>Drive URL or file ID</span>
              <input
                type="text"
                value={newSourceInput}
                onChange={(e) => setNewSourceInput(e.target.value)}
                placeholder="https://docs.google.com/document/d/... or file ID"
                disabled={addSourceLoading}
              />
            </label>
            <label>
              <span>Type</span>
              <select
                value={newSourceType}
                onChange={(e) => setNewSourceType(e.target.value as SourceType)}
                disabled={addSourceLoading}
              >
                <option value="gdoc">Google Doc</option>
                <option value="gslides">Google Slides</option>
                <option value="gpdf">PDF</option>
              </select>
            </label>
            <label>
              <span>Title (optional)</span>
              <input
                type="text"
                value={newSourceTitle}
                onChange={(e) => setNewSourceTitle(e.target.value)}
                placeholder="Display name"
                disabled={addSourceLoading}
              />
            </label>
            <button type="submit" disabled={addSourceLoading || !newSourceInput.trim()}>
              {addSourceLoading ? "Adding..." : "Add source"}
            </button>
          </form>
        ) : null}
        {connection ? (
          <p className="muted small-text">
            Connected subject: <code>{connection.google_subject}</code>
          </p>
        ) : null}
        <div className="project-switcher">
          <span className="muted">Project:</span>
          <select
            value={project.id}
            onChange={(event) =>
              navigate(`/projects/${event.target.value}/settings`, { replace: false })
            }
          >
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.handle})
              </option>
            ))}
          </select>
        </div>
        <form className="grid-form" onSubmit={updateProjectSettings}>
          <label className="full-width">
            <span>Allowed origins (one per line or comma-separated)</span>
            <textarea
              value={originsInput}
              onChange={(event) => setOriginsInput(event.target.value)}
              rows={4}
              placeholder="https://example.com"
            />
          </label>

          <label>
            <span>Rate limit RPM</span>
            <input
              type="number"
              min={1}
              value={form.rate_rpm}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  rate_rpm: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            <span>Rate burst</span>
            <input
              type="number"
              min={1}
              value={form.rate_burst}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  rate_burst: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            <span>Daily request quota</span>
            <input
              type="number"
              min={1}
              value={form.quota_daily_requests}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  quota_daily_requests: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            <span>Monthly request quota</span>
            <input
              type="number"
              min={1}
              value={form.quota_monthly_requests}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  quota_monthly_requests: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            <span>Daily token quota (optional)</span>
            <input
              type="number"
              min={1}
              value={form.quota_daily_tokens}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  quota_daily_tokens: event.target.value,
                }))
              }
              placeholder="leave empty for none"
            />
          </label>
          <label>
            <span>Monthly token quota (optional)</span>
            <input
              type="number"
              min={1}
              value={form.quota_monthly_tokens}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  quota_monthly_tokens: event.target.value,
                }))
              }
              placeholder="leave empty for none"
            />
          </label>

          <label className="full-width">
            <span>Input validation prompt</span>
            <textarea
              value={form.input_validation_prompt}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  input_validation_prompt: event.target.value,
                }))
              }
              rows={5}
            />
          </label>
          <label className="full-width">
            <span>Output validation prompt</span>
            <textarea
              value={form.output_validation_prompt}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  output_validation_prompt: event.target.value,
                }))
              }
              rows={5}
            />
          </label>
          <button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save settings"}
          </button>
        </form>
        {error ? <p className="error">{error}</p> : null}
        {notice ? <p className="notice">{notice}</p> : null}
      </section>

      <section className="panel">
        <h2>Source ingestion status</h2>
        <div className="status-row">
          <span className="status-pill status-pending">
            pending: {sourceStatusCounts.pending}
          </span>
          <span className="status-pill status-processing">
            processing: {sourceStatusCounts.processing}
          </span>
          <span className="status-pill status-ready">
            ready: {sourceStatusCounts.ready}
          </span>
          <span className="status-pill status-failed">
            failed: {sourceStatusCounts.failed}
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Status</th>
                <th>Added</th>
                <th>Last update</th>
                <th>Error</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sourceRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    No sources added yet.
                  </td>
                </tr>
              ) : (
                sourceRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.title || row.drive_file_id}</td>
                    <td>{row.source_type}</td>
                    <td>{row.status}</td>
                    <td>{new Date(row.created_at).toLocaleString()}</td>
                    <td>{new Date(row.updated_at).toLocaleString()}</td>
                    <td>{row.error ?? "-"}</td>
                    <td className="row-actions">
                      <button
                        type="button"
                        onClick={() => void triggerResync(row)}
                        disabled={sourceActionLoadingId === row.id}
                      >
                        Re-sync
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeSource(row)}
                        disabled={sourceActionLoadingId === row.id}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Usage summary</h2>
        <div className="usage-grid">
          <article>
            <h3>Daily (last 14)</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Requests</th>
                    <th>Tokens in</th>
                    <th>Tokens out</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyUsage.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="muted">
                        No daily usage yet.
                      </td>
                    </tr>
                  ) : (
                    dailyUsage.map((row) => (
                      <tr key={row.usage_date}>
                        <td>{row.usage_date}</td>
                        <td>{row.requests}</td>
                        <td>{row.tokens_in}</td>
                        <td>{row.tokens_out}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </article>
          <article>
            <h3>Monthly (last 12)</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Requests</th>
                    <th>Tokens in</th>
                    <th>Tokens out</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyUsage.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="muted">
                        No monthly usage yet.
                      </td>
                    </tr>
                  ) : (
                    monthlyUsage.map((row) => (
                      <tr key={row.month_start}>
                        <td>{row.month_start}</td>
                        <td>{row.requests}</td>
                        <td>{row.tokens_in}</td>
                        <td>{row.tokens_out}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </article>
        </div>
      </section>

      <section className="panel">
        <h2>Audit summary</h2>
        <div className="filter-row">
          {HIGH_SIGNAL_EVENTS.map((eventType) => (
            <label key={eventType} className="checkbox-pill">
              <input
                type="checkbox"
                checked={selectedEventFilters.includes(eventType)}
                onChange={() => toggleEventFilter(eventType)}
              />
              <span>{eventType}</span>
            </label>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Origin</th>
                <th>Request ID</th>
              </tr>
            </thead>
            <tbody>
              {auditRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    No matching audit rows yet.
                  </td>
                </tr>
              ) : (
                auditRows.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.created_at).toLocaleString()}</td>
                    <td>{row.event_type}</td>
                    <td>{row.origin ?? "-"}</td>
                    <td>
                      <code>{row.request_id}</code>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
