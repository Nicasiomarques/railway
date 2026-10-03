import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, ApiProblem, type Environment, type Organization, type Project } from "../api";

// Accepted values per api/src/routes/services.ts. "template" exists on the API but is out of scope here:
// this wizard only covers sources that don't need a working GitHub App install (see module comment below).
const KINDS = ["web", "worker", "postgres", "redis"] as const;
const SOURCES = ["github_repo", "image"] as const;
type Kind = (typeof KINDS)[number];
type Source = (typeof SOURCES)[number];

const STEP_LABELS = ["Organization", "Project", "Environment", "Service"];

// Service name rule enforced by the API (api/src/routes/services.ts).
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Same http(s)-only check the API makes on repoUrl.
const REPO_URL_PATTERN = /^https?:\/\/\S+$/;

type CreatedService = {
  id: string;
  name: string;
  kind: string;
  source: string;
  instances: { id: string }[];
};

// A guided, multi-step "New service" flow that only uses APIs that actually exist in this app
// (api/src/github/clients.ts is a noop — there is no real GitHub App install/OAuth here, so this is
// a form wizard, not a repo browser): pick/create an organization, pick/create a project, confirm an
// environment, then define and create the service (github_repo by typed URL, or image — whose digest
// is supplied later, from a deployment on the project page).
export function NewServiceWizard({
  defaultOrgId,
  onClose,
  onCreated,
}: {
  defaultOrgId?: string | null;
  onClose: () => void;
  onCreated: (project: { id: string; name: string; organizationId: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [error, setError] = useState<string | null>(null);

  // Step 1: organization -----------------------------------------------------------------------
  const [org, setOrg] = useState<Organization | null>(null);
  const [orgMode, setOrgMode] = useState<"existing" | "new">("existing");
  const [newOrgName, setNewOrgName] = useState("");
  const [creatingOrg, setCreatingOrg] = useState(false);

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => api<{ data: Organization[] }>("/organizations").then((r) => r.data),
  });

  useEffect(() => {
    if (org || !defaultOrgId || !orgsQuery.data) return;
    const found = orgsQuery.data.find((o) => o.id === defaultOrgId);
    if (found) setOrg(found);
  }, [defaultOrgId, orgsQuery.data, org]);

  async function createOrganization() {
    setError(null);
    setCreatingOrg(true);
    try {
      const created = await api<{ id: string; name: string; slug: string }>("/organizations", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        json: { name: newOrgName.trim() },
      });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      setOrg({ id: created.id, name: created.name, slug: created.slug, role: "owner" });
      setOrgMode("existing");
      setNewOrgName("");
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error creating organization.");
    } finally {
      setCreatingOrg(false);
    }
  }

  // Step 2: project -----------------------------------------------------------------------------
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);
  const [projectMode, setProjectMode] = useState<"existing" | "new">("existing");
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);

  const canWrite = !org || org.role !== "viewer";

  const projectsQuery = useQuery({
    queryKey: ["projects", org?.id],
    queryFn: () => api<{ data: Project[] }>(`/projects?organizationId=${org!.id}&limit=50`).then((r) => r.data),
    enabled: !!org,
  });

  async function createProject() {
    if (!org) return;
    setError(null);
    setCreatingProject(true);
    try {
      const created = await api<{ id: string; name: string }>("/projects", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        json: { organizationId: org.id, name: newProjectName.trim() },
      });
      queryClient.invalidateQueries({ queryKey: ["projects", org.id] });
      setProject({ id: created.id, name: created.name });
      setProjectMode("existing");
      setNewProjectName("");
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error creating project.");
    } finally {
      setCreatingProject(false);
    }
  }

  // Step 3: environment -------------------------------------------------------------------------
  const [environment, setEnvironment] = useState<Environment | null>(null);

  const environmentsQuery = useQuery({
    queryKey: ["environments", project?.id],
    queryFn: () => api<{ data: Environment[] }>(`/projects/${project!.id}/environments`).then((r) => r.data),
    enabled: !!project,
  });

  useEffect(() => {
    if (!environment && environmentsQuery.data?.[0]) setEnvironment(environmentsQuery.data[0]);
  }, [environment, environmentsQuery.data]);

  // Step 4: service definition -------------------------------------------------------------------
  const [serviceName, setServiceName] = useState("");
  const [kind, setKind] = useState<Kind>("web");
  const [source, setSource] = useState<Source>("github_repo");
  const [repoUrl, setRepoUrl] = useState("");

  const nameValid = NAME_PATTERN.test(serviceName);
  const repoUrlValid = source !== "github_repo" || REPO_URL_PATTERN.test(repoUrl.trim());
  const step4Valid = nameValid && repoUrlValid;

  // Step 5: submit --------------------------------------------------------------------------------
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedService | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function submitService() {
    if (!project) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body: Record<string, unknown> = { name: serviceName, kind, source };
      if (source === "github_repo") body.repoUrl = repoUrl.trim();
      const result = await api<CreatedService>(`/projects/${project.id}/services`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        json: body,
      });
      setCreated(result);
      queryClient.invalidateQueries({ queryKey: ["services", project.id] });
    } catch (err) {
      setSubmitError(err instanceof ApiProblem ? err.message : "Error creating service.");
    } finally {
      setSubmitting(false);
    }
  }

  function goToReview() {
    setError(null);
    setStep(5);
    setCreated(null);
    setSubmitError(null);
    submitService();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>New service</h2>
          <button className="ghost small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {step <= 4 && (
          <p className="wizard-step-indicator">
            Step {step} of 4 — {STEP_LABELS[step - 1]}
          </p>
        )}

        {step === 1 && (
          <section>
            <h3>Organization</h3>
            <div className="wizard-toggle">
              <button className={orgMode === "existing" ? "tab active" : "tab"} onClick={() => setOrgMode("existing")}>
                Use existing
              </button>
              <button className={orgMode === "new" ? "tab active" : "tab"} onClick={() => setOrgMode("new")}>
                Create new
              </button>
            </div>

            {orgMode === "existing" && (
              <ul className="list">
                {orgsQuery.isLoading && <li className="muted">Loading organizations...</li>}
                {orgsQuery.data?.map((o) => (
                  <li key={o.id}>
                    <button className={org?.id === o.id ? "row selected" : "row"} onClick={() => setOrg(o)}>
                      <span>{o.name}</span>
                      <span className="pill">{o.role}</span>
                    </button>
                  </li>
                ))}
                {orgsQuery.data?.length === 0 && <li className="muted">No organizations yet — create one.</li>}
              </ul>
            )}

            {orgMode === "new" && (
              <form
                className="inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  createOrganization();
                }}
              >
                <input
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  placeholder="New organization name"
                />
                <button type="submit" disabled={!newOrgName.trim() || creatingOrg}>
                  {creatingOrg ? "Creating..." : "Create organization"}
                </button>
              </form>
            )}

            {error && <p className="error">{error}</p>}

            <div className="wizard-actions">
              <button className="ghost" disabled>
                Back
              </button>
              <button onClick={() => setStep(2)} disabled={!org}>
                Next
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section>
            <h3>Project</h3>
            <p className="muted">
              Organization: <strong>{org?.name}</strong>
            </p>
            {!canWrite && (
              <p className="error">
                Your role here is "viewer" — you can&apos;t create projects in this organization. Go back and pick
                another one.
              </p>
            )}

            <div className="wizard-toggle">
              <button className={projectMode === "existing" ? "tab active" : "tab"} onClick={() => setProjectMode("existing")}>
                Use existing
              </button>
              <button
                className={projectMode === "new" ? "tab active" : "tab"}
                onClick={() => setProjectMode("new")}
                disabled={!canWrite}
              >
                Create new
              </button>
            </div>

            {projectMode === "existing" && (
              <ul className="list">
                {projectsQuery.isLoading && <li className="muted">Loading projects...</li>}
                {projectsQuery.data?.map((p) => (
                  <li key={p.id}>
                    <button
                      className={project?.id === p.id ? "row selected" : "row"}
                      onClick={() => setProject({ id: p.id, name: p.name })}
                    >
                      <span>{p.name}</span>
                      <span className="muted">{p.slug}</span>
                    </button>
                  </li>
                ))}
                {projectsQuery.data?.length === 0 && <li className="muted">No projects yet in this organization.</li>}
              </ul>
            )}

            {projectMode === "new" && canWrite && (
              <form
                className="inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  createProject();
                }}
              >
                <input
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="New project name"
                />
                <button type="submit" disabled={!newProjectName.trim() || creatingProject}>
                  {creatingProject ? "Creating..." : "Create project"}
                </button>
              </form>
            )}

            {error && <p className="error">{error}</p>}

            <div className="wizard-actions">
              <button
                className="ghost"
                onClick={() => {
                  setError(null);
                  setStep(1);
                }}
              >
                Back
              </button>
              <button
                onClick={() => {
                  setError(null);
                  setStep(3);
                }}
                disabled={!project}
              >
                Next
              </button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section>
            <h3>Environment</h3>
            <p className="muted">
              Project: <strong>{project?.name}</strong>
            </p>
            {environmentsQuery.isLoading && <p className="muted">Loading environments...</p>}
            <div className="chips">
              {environmentsQuery.data?.map((env) => (
                <button
                  key={env.id}
                  className={environment?.id === env.id ? "tab active" : "tab"}
                  onClick={() => setEnvironment(env)}
                >
                  {env.name}
                </button>
              ))}
            </div>
            <p className="muted">
              The new service gets one instance in every environment of this project automatically (projects start
              with "production"). Pick the one you want to land on after creation.
            </p>

            <div className="wizard-actions">
              <button className="ghost" onClick={() => setStep(2)}>
                Back
              </button>
              <button onClick={() => setStep(4)} disabled={!environment}>
                Next
              </button>
            </div>
          </section>
        )}

        {step === 4 && (
          <section>
            <h3>Service</h3>

            <label>
              Name
              <input value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="my-api" />
            </label>
            {serviceName !== "" && !nameValid && (
              <p className="error">Use lowercase letters, numbers and hyphens (e.g. "my-api").</p>
            )}

            <label>
              Kind
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Source
              <select value={source} onChange={(e) => setSource(e.target.value as Source)}>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            {source === "github_repo" && (
              <label>
                Repository URL
                <input
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git"
                />
              </label>
            )}
            {source === "github_repo" && repoUrl !== "" && !repoUrlValid && (
              <p className="error">Use an http(s) URL.</p>
            )}
            {source === "image" && (
              <p className="muted">
                No image reference is needed here — there&apos;s no repo browser or image registry picker in this
                app. Once the service exists, start a deployment from the project page and give it an image digest.
              </p>
            )}

            <div className="wizard-summary">
              <h4>About to create</h4>
              <ul>
                <li>
                  <span className="muted">Organization</span> {org?.name}
                </li>
                <li>
                  <span className="muted">Project</span> {project?.name}
                </li>
                <li>
                  <span className="muted">Environment</span> {environment?.name}
                </li>
                <li>
                  <span className="muted">Service</span> {serviceName || "—"} <span className="pill">{kind}</span>
                </li>
                <li>
                  <span className="muted">Source</span>{" "}
                  {source === "github_repo" ? repoUrl.trim() || "—" : "image (digest set later, when deploying)"}
                </li>
              </ul>
            </div>

            <div className="wizard-actions">
              <button className="ghost" onClick={() => setStep(3)}>
                Back
              </button>
              <button onClick={goToReview} disabled={!step4Valid || !canWrite}>
                Review &amp; create
              </button>
            </div>
          </section>
        )}

        {step === 5 && (
          <section>
            <h3>{submitting ? "Creating..." : created ? "Service created" : "Couldn't create service"}</h3>

            {submitting && (
              <p className="muted">
                Creating "{serviceName}" in {project?.name}...
              </p>
            )}

            {created && (
              <>
                <p>
                  <strong>{created.name}</strong> was created as a <span className="pill">{created.kind}</span>{" "}
                  service ({created.source}), with {created.instances.length} instance
                  {created.instances.length === 1 ? "" : "s"}.
                </p>
                <div className="wizard-actions">
                  <button className="ghost" onClick={onClose}>
                    Close
                  </button>
                  <button
                    onClick={() => project && org && onCreated({ id: project.id, name: project.name, organizationId: org.id })}
                  >
                    Open project
                  </button>
                </div>
              </>
            )}

            {submitError && (
              <>
                <p className="error">{submitError}</p>
                <div className="wizard-actions">
                  <button className="ghost" onClick={() => setStep(4)}>
                    Back
                  </button>
                  <button onClick={submitService}>Try again</button>
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
