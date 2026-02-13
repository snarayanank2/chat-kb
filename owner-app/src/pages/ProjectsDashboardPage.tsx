import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { normalizeHandle, validateHandle } from "../lib/validation";
import { useAuth } from "../state/AuthContext";
import type { ProjectRow, ProjectSourceRow, SourceStatus } from "../types/database";

type StatusCounts = Record<SourceStatus, number>;

const EMPTY_COUNTS: StatusCounts = {
  pending: 0,
  processing: 0,
  ready: 0,
  failed: 0,
};

export function ProjectsDashboardPage() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [sourceRows, setSourceRows] = useState<ProjectSourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", handle: "" });
  const [saving, setSaving] = useState(false);

  const sourceCountsByProject = useMemo(() => {
    const byProject = new Map<string, StatusCounts>();
    for (const row of sourceRows) {
      const current = byProject.get(row.project_id) ?? { ...EMPTY_COUNTS };
      current[row.status] += 1;
      byProject.set(row.project_id, current);
    }
    return byProject;
  }, [sourceRows]);

  const loadData = async () => {
    setLoading(true);
    setError(null);

    const { data: projectData, error: projectError } = await supabase
      .from("projects")
      .select("*")
      .order("created_at", { ascending: false });

    if (projectError) {
      setError(projectError.message);
      setLoading(false);
      return;
    }

    setProjects(projectData ?? []);

    if (!projectData?.length) {
      setSourceRows([]);
      setLoading(false);
      return;
    }

    const ids = projectData.map((project) => project.id);
    const { data: sourceData, error: sourceError } = await supabase
      .from("project_sources")
      .select(
        "id,project_id,source_type,drive_file_id,mime_type,title,status,error,created_at,updated_at",
      )
      .in("project_id", ids);

    if (sourceError) {
      setError(sourceError.message);
    } else {
      setSourceRows(sourceData ?? []);
    }

    setLoading(false);
  };

  useEffect(() => {
    void loadData();
  }, []);

  const onHandleChange = (value: string) => {
    const normalized = normalizeHandle(value);
    setForm((current) => ({ ...current, handle: normalized }));
  };

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;

    const name = form.name.trim();
    const handle = normalizeHandle(form.handle);
    const validationError = validateHandle(handle);
    if (!name) {
      setError("Project name is required.");
      return;
    }
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);

    const { data: existing, error: existingError } = await supabase
      .from("projects")
      .select("id")
      .ilike("handle", handle)
      .limit(1);

    if (existingError) {
      setSaving(false);
      setError(existingError.message);
      return;
    }

    if (existing?.length) {
      setSaving(false);
      setError("Handle is already taken.");
      return;
    }

    const { error: insertError } = await supabase.from("projects").insert({
      owner_user_id: user.id,
      name,
      handle,
    });

    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }

    setForm({ name: "", handle: "" });
    await loadData();
  };

  const deleteProject = async (project: ProjectRow) => {
    const ok = window.confirm(
      `Delete "${project.name}"? This will remove sources, chunks, and logs for that project.`,
    );
    if (!ok) return;

    const { error: deleteError } = await supabase
      .from("projects")
      .delete()
      .eq("id", project.id);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    await loadData();
  };

  if (loading) {
    return <p className="state-text">Loading projects...</p>;
  }

  return (
    <div className="stack">
      <section className="panel">
        <h1>Projects</h1>
        <p className="muted">
          Create and manage knowledge-base projects owned by your account.
        </p>
        <form className="grid-form" onSubmit={createProject}>
          <label>
            <span>Project name</span>
            <input
              type="text"
              value={form.name}
              onChange={(event) =>
                setForm((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="Support Docs"
              required
            />
          </label>
          <label>
            <span>Project handle</span>
            <input
              type="text"
              value={form.handle}
              onChange={(event) => onHandleChange(event.target.value)}
              placeholder="support-docs"
              required
            />
          </label>
          <button type="submit" disabled={saving}>
            {saving ? "Creating..." : "Create project"}
          </button>
        </form>
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="panel">
        <h2>Your projects</h2>
        {projects.length === 0 ? (
          <p className="muted">No projects yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Handle</th>
                  <th>Origins</th>
                  <th>Source status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => {
                  const counts = sourceCountsByProject.get(project.id) ?? EMPTY_COUNTS;
                  return (
                    <tr key={project.id}>
                      <td>{project.name}</td>
                      <td>
                        <code>{project.handle}</code>
                      </td>
                      <td>{project.allowed_origins.length}</td>
                      <td className="status-row">
                        <StatusBadge status="pending" count={counts.pending} />
                        <StatusBadge status="processing" count={counts.processing} />
                        <StatusBadge status="ready" count={counts.ready} />
                        <StatusBadge status="failed" count={counts.failed} />
                      </td>
                      <td className="row-actions">
                        <Link to={`/projects/${project.id}/settings`}>Settings</Link>
                        <button type="button" onClick={() => deleteProject(project)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status, count }: { status: SourceStatus; count: number }) {
  return (
    <span className={`status-pill status-${status}`}>
      {status}: {count}
    </span>
  );
}
