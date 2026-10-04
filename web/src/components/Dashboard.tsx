import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, tokenStore, type Organization } from "../api";
import { AuditLogPanel } from "./AuditLogPanel";
import { NewServiceWizard } from "./NewServiceWizard";
import { ProjectDetail } from "./ProjectDetail";
import { ProjectList } from "./ProjectList";
import { UsagePanel } from "./UsagePanel";
import { applyTheme, getStoredTheme, type Theme } from "../theme";

type NavView = "projects" | "usage" | "audit";

export function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const orgs = useQuery({
    queryKey: ["organizations"],
    queryFn: () => api<{ data: Organization[] }>("/organizations").then((r) => r.data),
  });
  const [orgId, setOrgId] = useState<string | null>(null);
  const [view, setView] = useState<NavView>("projects");
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());

  const selectedOrg = orgs.data?.find((o) => o.id === orgId) ?? orgs.data?.[0];

  function goTo(next: NavView) {
    setView(next);
    setProject(null);
  }

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          railway_like
        </div>

        {orgs.data && orgs.data.length > 1 && (
          <div className="org-switcher">
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
          </div>
        )}

        <div className="nav-group">
          <span className="nav-label">Workspace</span>
          <button className={view === "projects" && !project ? "nav-item active" : "nav-item"} onClick={() => goTo("projects")}>
            <span className="dot" /> Projects
          </button>
          <button className={view === "usage" ? "nav-item active" : "nav-item"} onClick={() => goTo("usage")}>
            <span className="dot" /> Usage
          </button>
          <button className={view === "audit" ? "nav-item active" : "nav-item"} onClick={() => goTo("audit")}>
            <span className="dot" /> Audit log
          </button>
        </div>

        {selectedOrg && selectedOrg.role !== "viewer" && (
          <button onClick={() => setShowWizard(true)}>+ New</button>
        )}

        <div className="sidebar-spacer" />

        <div className="sidebar-foot">
          <div className="theme-toggle">
            <span className="muted">Theme</span>
            <button className="ghost small" onClick={toggleTheme}>
              {theme === "dark" ? "Dark" : "Light"}
            </button>
          </div>
          <button
            className="ghost nav-item"
            onClick={() => {
              tokenStore.clear();
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="content">
        <div className="topbar">
          <div className="breadcrumb">
            {project ? (
              <>
                <button className="ghost" onClick={() => setProject(null)}>
                  Projects
                </button>
                <span className="sep">/</span>
                <strong>{project.name}</strong>
              </>
            ) : (
              <strong>{selectedOrg?.name ?? "Workspace"}</strong>
            )}
          </div>
        </div>

        <main>
          {orgs.isLoading && <p className="muted">Loading...</p>}
          {orgs.data && orgs.data.length === 0 && <p className="muted">No organizations for this token.</p>}

          {selectedOrg && !project && view === "projects" && (
            <ProjectList org={selectedOrg} onOpen={setProject} />
          )}
          {selectedOrg && view === "usage" && <UsagePanel org={selectedOrg} />}
          {selectedOrg && view === "audit" && <AuditLogPanel organizationId={selectedOrg.id} />}
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

      {showWizard && (
        <NewServiceWizard
          defaultOrgId={selectedOrg?.id ?? null}
          onClose={() => setShowWizard(false)}
          onCreated={(createdProject) => {
            setOrgId(createdProject.organizationId);
            setProject({ id: createdProject.id, name: createdProject.name });
            setShowWizard(false);
          }}
        />
      )}
    </div>
  );
}
