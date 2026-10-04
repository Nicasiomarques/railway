import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiProblem, type Organization, type Project } from "../api";

export function ProjectList({
  org,
  onOpen,
}: {
  org: Organization;
  onOpen: (project: { id: string; name: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const projects = useQuery({
    queryKey: ["projects", org.id],
    queryFn: () =>
      api<{ data: Project[] }>(`/projects?organizationId=${org.id}&limit=50`).then((r) => r.data),
  });

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/projects", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        json: { organizationId: org.id, name },
      });
      setName("");
      setAdding(false);
      queryClient.invalidateQueries({ queryKey: ["projects", org.id] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error creating project.");
    }
  }

  return (
    <section>
      <div className="section-head">
        <h2>{org.name}</h2>
        <span className="pill">{org.role}</span>
      </div>

      {error && <p className="error">{error}</p>}

      <ul className="list">
        {projects.data?.map((p) => (
          <li key={p.id}>
            <button className="row" onClick={() => onOpen({ id: p.id, name: p.name })}>
              <span>{p.name}</span>
              <span className="muted">{p.slug}</span>
            </button>
          </li>
        ))}
        {projects.data?.length === 0 && <li className="muted">No projects yet.</li>}
      </ul>

      {org.role !== "viewer" && (
        <div className="disclose">
          {!adding ? (
            <button className="disclose-trigger" onClick={() => setAdding(true)}>
              + New project
            </button>
          ) : (
            <form className="disclose-body inline wrap" onSubmit={create}>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" autoFocus />
              <button type="submit" disabled={!name.trim()}>
                Create
              </button>
              <button type="button" className="ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
