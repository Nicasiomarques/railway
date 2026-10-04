import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, tokenStore, type Organization } from "../api";
import { AuditLogPanel } from "./AuditLogPanel";
import { NavIcon } from "./NavIcon";
import { NewServiceWizard } from "./NewServiceWizard";
import { ProjectDetail } from "./ProjectDetail";
import { ProjectList } from "./ProjectList";
import { UsagePanel } from "./UsagePanel";
import { applyTheme, getStoredTheme, type Theme } from "../theme";

type NavView = "projects" | "usage" | "audit";

const SIDEBAR_COLLAPSED_KEY = "railway_like.sidebarCollapsed";

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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const selectedOrg = orgs.data?.find((o) => o.id === orgId) ?? orgs.data?.[0];

  function goTo(next: NavView) {
    setView(next);
    setProject(null);
    setMobileNavOpen(false);
  }

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  }

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // localStorage can be unavailable (private browsing, blocked storage) -- the toggle
        // still works for this session, it just won't be remembered next time.
      }
      return next;
    });
  }

  return (
    <div className="shell">
      {mobileNavOpen && <div className="sidebar-overlay" onClick={() => setMobileNavOpen(false)} />}
      <aside className={[mobileNavOpen && "open", collapsed && "collapsed", "sidebar"].filter(Boolean).join(" ")}>
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-text">railway_like</span>
          <button className="ghost icon sidebar-close" onClick={() => setMobileNavOpen(false)} aria-label="Close menu">
            ✕
          </button>
          <button
            className="ghost icon sidebar-collapse-btn"
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <NavIcon name="collapse" />
          </button>
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
          <button
            className={view === "projects" && !project ? "nav-item active" : "nav-item"}
            onClick={() => goTo("projects")}
            title="Projects"
          >
            <NavIcon name="projects" /> <span className="nav-item-text">Projects</span>
          </button>
          <button className={view === "usage" ? "nav-item active" : "nav-item"} onClick={() => goTo("usage")} title="Usage">
            <NavIcon name="usage" /> <span className="nav-item-text">Usage</span>
          </button>
          <button className={view === "audit" ? "nav-item active" : "nav-item"} onClick={() => goTo("audit")} title="Audit log">
            <NavIcon name="audit" /> <span className="nav-item-text">Audit log</span>
          </button>
        </div>

        {selectedOrg && selectedOrg.role !== "viewer" && (
          <button className="new-service-btn" onClick={() => setShowWizard(true)} title="New">
            <NavIcon name="new" /> <span className="nav-item-text">New</span>
          </button>
        )}

        <div className="sidebar-spacer" />

        <div className="sidebar-foot">
          <button className="ghost nav-item theme-toggle-btn" onClick={toggleTheme} title={theme === "dark" ? "Dark theme" : "Light theme"}>
            <NavIcon name="theme" /> <span className="nav-item-text">{theme === "dark" ? "Dark" : "Light"}</span>
          </button>
          <button
            className="ghost nav-item"
            onClick={() => {
              tokenStore.clear();
              onSignOut();
            }}
            title="Sign out"
          >
            <NavIcon name="sign-out" /> <span className="nav-item-text">Sign out</span>
          </button>
        </div>
      </aside>

      <div className="content">
        <div className="topbar">
          <button className="ghost icon mobile-menu-btn" onClick={() => setMobileNavOpen(true)} aria-label="Open menu">
            ☰
          </button>
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

        <main className={project ? "wide" : undefined}>
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
