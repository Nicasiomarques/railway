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
      queryClient.invalidateQueries({ queryKey: ["projects", org.id] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Erro ao criar projeto.");
    }
  }

  return (
    <section>
      <div className="section-head">
        <h2>{org.name}</h2>
        <span className="pill">{org.role}</span>
      </div>

      {org.role !== "viewer" && (
        <form className="inline" onSubmit={create}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do novo projeto" />
          <button type="submit" disabled={!name.trim()}>
            Criar projeto
          </button>
        </form>
      )}
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
        {projects.data?.length === 0 && <li className="muted">Nenhum projeto ainda.</li>}
      </ul>
    </section>
  );
}
