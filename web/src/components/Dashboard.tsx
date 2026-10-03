import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, tokenStore, type Organization } from "../api";
import { ProjectDetail } from "./ProjectDetail";
import { ProjectList } from "./ProjectList";
import { UsagePanel } from "./UsagePanel";

export function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const orgs = useQuery({
    queryKey: ["organizations"],
    queryFn: () => api<{ data: Organization[] }>("/organizations").then((r) => r.data),
  });
  const [orgId, setOrgId] = useState<string | null>(null);
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);

  const selectedOrg = orgs.data?.find((o) => o.id === orgId) ?? orgs.data?.[0];

  return (
    <div className="shell">
      <header>
        <strong>railway_like</strong>
        <div className="header-right">
          {orgs.data && orgs.data.length > 1 && (
            <select
              value={selectedOrg?.id ?? ""}
              onChange={(e) => {
                setOrgId(e.target.value);
                setProject(null);
              }}
            >
              {orgs.data.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
          <button
            className="ghost"
            onClick={() => {
              tokenStore.clear();
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main>
        {orgs.isLoading && <p className="muted">Loading...</p>}
        {orgs.data && orgs.data.length === 0 && <p className="muted">No organizations for this token.</p>}

        {selectedOrg && !project && (
          <>
            <ProjectList org={selectedOrg} onOpen={setProject} />
            <UsagePanel org={selectedOrg} />
          </>
        )}
        {selectedOrg && project && (
          <ProjectDetail
            projectId={project.id}
            projectName={project.name}
            canWrite={selectedOrg.role !== "viewer"}
            onBack={() => setProject(null)}
          />
        )}
      </main>
    </div>
  );
}
