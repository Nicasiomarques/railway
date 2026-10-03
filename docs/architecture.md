# Arquitetura

Plataforma PaaS inspirada na Railway: `Connect → Configure → Deploy → Observe → Scale`.

> Status: rascunho. Decisões marcadas como **[EM ABERTO]** dependem de validação na Fase 0 (ver `roadmap.md`).

---

## 1. Princípios

- **Modular monolith + workers**, não microserviços. Módulos com fronteiras claras, prontos para virar serviços depois.
- **Postgres é a fonte da verdade.** O runtime é apenas estado observado.
- **Reconciliação, não comandos diretos.** Deploy altera o estado desejado; um reconciliador converge o runtime.
- **Jobs idempotentes e retomáveis.** Cada etapa grava progresso.
- **Convention over configuration.** Detecção automática, override sempre disponível.

---

## 2. Visão geral

```
                 ┌────────────────────────────┐
  Browser ─────▶ │  Web (React)               │
  CLI     ─────▶ │  Public API (REST/OpenAPI) │◀──── GitHub App webhooks
                 └──────────────┬─────────────┘
                                │
                 ┌──────────────▼─────────────┐
                 │  Core domain (módulos):    │
                 │  auth · projects · envs ·  │
                 │  services · vars · domains │
                 │  deployments · usage       │
                 └───────┬─────────────┬──────┘
                         │ Postgres    │ Job queue
                 ┌───────▼─────┐  ┌────▼────────────────────────┐
                 │ Source of   │  │ Workers                     │
                 │ truth       │  │  · build-orchestrator       │
                 └─────────────┘  │  · deploy-reconciler        │
                                  │  · domain/TLS              │
                                  │  · usage-aggregator         │
                                  │  · preview-janitor          │
                                  └───┬─────────────┬───────────┘
                                      │             │
                   ┌──────────────────▼──┐   ┌──────▼──────────────────┐
                   │ Build farm          │   │ Runtime adapter         │
                   │ (BuildKit rootless, │   │ (K8s hoje; interface    │
                   │  em sandbox)        │   │  permite trocar)        │
                   └──────────┬──────────┘   └──────┬──────────────────┘
                              │ image digest         │
                   ┌──────────▼──────────┐   ┌──────▼──────────────────┐
                   │ Registry            │   │ Edge (ingress + TLS)    │
                   └─────────────────────┘   │ Observabilidade         │
                                             └─────────────────────────┘
```

---

## 3. Componentes

| Componente | Responsabilidade | Observação |
|---|---|---|
| Web | Dashboard, canvas, logs, métricas | SPA (React) |
| API | Toda a funcionalidade exposta; auth; validação | Mesma API para web, CLI e integrações |
| Auth | Login, sessões, API tokens, RBAC | Provedor externo no MVP |
| GitHub integration | Webhooks, checks, tokens de instalação | GitHub App, não OAuth App |
| Detector | Analisa repo e sugere plano de build/run | Função pura: árvore de arquivos → plano + justificativas |
| Build orchestrator | Cria jobs de build, cache, timeouts, cancelamento | Cancela builds obsoletos do mesmo serviço |
| Builder | Executa build em sandbox e publica imagem por digest | BuildKit rootless; Buildpacks para linguagens |
| Deploy reconciler | Converte deployment em workload | Único componente que escreve no runtime |
| Runtime adapter | `createWorkload`, `setReplicas`, `getStatus`, `tailLogs` | Abstração para trocar o backend |
| Edge controller | Roteamento por host, certificados, domínios | Consome o estado de `domains` |
| Log pipeline | Coleta stdout/stderr, indexa, tail em tempo real | Armazenamento fora do Postgres |
| Metrics pipeline | CPU, memória, rede, restarts | Agregado por instância |
| Usage aggregator | Amostras → `usage_events` por projeto/serviço | Alimenta billing futuro |
| Preview janitor | TTL, sleep e limpeza de previews | Job periódico |

---

## 4. Modelo de dados

Distinção central: **Service** é a definição; **ServiceInstance** é o serviço dentro de um ambiente, com configs e deployments próprios.

```text
Organization ─┬─ Membership (user, role)
              └─ Project
                   ├─ Environment (name, type: production|staging|preview|custom,
                   │               parent_env_id, branch_rule, ttl_at, sleep_policy)
                   ├─ Service (name, kind, source: github_repo|image|template,
                   │           root_dir, detection_snapshot)
                   │     └─ ServiceInstance (service_id, environment_id,
                   │                         resources, replicas, health_check, overrides)
                   │           ├─ Deployment (commit_sha, branch, author, version_no,
                   │           │              status, image_digest, env_snapshot_id,
                   │           │              triggered_by)
                   │           │     ├─ Build (logs_ref, cache_key, duration, exit_code)
                   │           │     └─ DeploymentEvent (from_status, to_status, reason, ts)
                   │           ├─ Domain (hostname, type: auto|custom, tls_state)
                   │           └─ Volume (size, mount_path)
                   ├─ Variable (scope: project|environment|service_instance,
                   │            key, value_enc, is_secret, version)
                   ├─ Connection (from_instance → to_instance)
                   └─ GitHubRepoLink (installation_id, repo_id, branch→env rules)

Plataforma:
  Runtime (cluster/região) · UsageEvent · AuditLog · Job · ApiToken
  EnvSnapshot (conjunto imutável de variáveis no momento do deploy)
```

**Decisões de modelagem**
- `EnvSnapshot` imutável por deployment: rollback restaura o snapshot, não o estado atual das variáveis.
- Herança resolvida na ordem serviço-ambiente → ambiente → projeto, gravada no snapshot.
- `version_no` sequencial por ServiceInstance.
- Secrets com criptografia de envelope; nunca logados.
- `usage_events` append-only, agregados em janelas (1 min → hora → dia).
- Soft delete para projetos e serviços.

---

## 5. Fluxo de deployment

### 5.1 Máquina de estados

```
Queued ──▶ Building ──▶ Deploying ──▶ HealthChecking ──▶ Running ──▶ Superseded
   │           │             │               │                   └──▶ RolledBack
   └───────────┴─────────────┴───────────────┴──▶ Failed
   Cancelled: a partir de qualquer estado não terminal
```

`Crashed` é estado do **runtime**, não do deployment.

### 5.2 Passo a passo

1. Webhook `push` → valida `X-Hub-Signature-256` → responde 202 → enfileira (idempotente por `X-GitHub-Delivery`).
2. Resolve ServiceInstances cujo `branch_rule` casa com a branch e cujo `root_dir` foi afetado pelo diff.
3. Cria `Deployment(Queued)` com SHA, autor e mensagem; cancela deployments não terminais anteriores da mesma instância.
4. Cria check run no GitHub (e GitHub Deployment, se houver environment vinculado).
5. Build: token de instalação de curta duração → clone no SHA exato → detector (se não houver config salva) → build em sandbox → push por digest.
6. Snapshot: resolve variáveis e referências, grava `EnvSnapshot`.
7. Deploy: reconciler cria/atualiza workload com `image@digest`, snapshot, limites e health check. Versão anterior segue ativa.
8. Health check: N sondagens com sucesso dentro do timeout. Falha → mantém anterior; deployment vira `Failed` com motivo legível.
9. Troca de tráfego no edge; anterior vira `Superseded`, disponível para rollback.
10. Atualiza check/status no GitHub e dispara notificações.

**Rollback:** novo deployment do tipo `rollback` apontando para `image_digest` e `EnvSnapshot` de uma versão anterior. **Não rebuilda.**

**Redeploy manual:** mesmo SHA/digest com novo snapshot de env (ou rebuild, por escolha explícita).

---

## 6. Provisioning de infraestrutura

Operações de infra são sagas de passos persistidos e idempotentes.

```text
CreateEnvironment(prod)
  1. reservar namespace/identificador lógico   [idempotente por env_id]
  2. aplicar NetworkPolicy default-deny
  3. aplicar ResourceQuota e LimitRange
  4. criar escopo no secret store
  5. marcar env como READY
```

- Cada passo grava status; retomada do ponto de falha.
- Todo recurso recebe labels `platform/project`, `platform/env`, `platform/instance`.
- GC por reconciliação: recursos órfãos são removidos após grace period.
- Stateful (Postgres/Redis/volumes): PVC + backup agendado (snapshot de volume + dump lógico) no object storage; restore é operação explícita e auditada.
- Domínio: hostname → DNS (wildcard para subdomínio automático) → certificado → rota no edge. Cada etapa visível ao usuário.

---

## 7. Isolamento dos workloads

### 7.1 Runtime

**Decidido:** k3s atrás de `RuntimeAdapter`. Mantém a API do Kubernetes (namespaces, NetworkPolicy, ResourceQuota) com operação bem menor que um cluster gerenciado.

| Opção | Prós | Contras |
|---|---|---|
| **k3s (escolhida)** | API Kubernetes completa em um binário; sem mudança no modelo de isolamento | Operação própria do cluster |
| Kubernetes gerenciado | Ecossistema, controle de rede e volumes | Operação pesada |
| Serverless de containers (Cloud Run / ECS Fargate) | Pouca ops; rápido para web/worker | Stateful e rede privada limitados |
| Nomad / Docker em VMs / Firecracker próprio | Ops mínima ou isolamento forte | Menos ecossistema ou muito trabalho de plataforma |

Isolamento de código não confiável (builds e workloads) continua exigindo gVisor, Kata ou microVM, independentemente do orquestrador. Ver 7.2.

### 7.2 Camadas

- **Builds:** nós dedicados; BuildKit rootless sem `privileged`; egress restrito a registries e GitHub; CPU/memória/tempo limitados; idealmente em microVM (Kata/Firecracker).
- **Workloads:**
  - Um namespace **por ambiente** (prod isolado de preview).
  - NetworkPolicy default-deny; liberação explícita de ingress pelo edge, tráfego entre serviços do mesmo ambiente e egress à internet.
  - Bloqueio de `169.254.169.254` e redes internas da plataforma.
  - Pod Security `restricted`; não-root; sem capabilities; seccomp `RuntimeDefault`.
  - Sandbox de runtime (gVisor ou Kata) para tenants não confiáveis.
  - `ResourceQuota` por projeto; `requests`/`limits` por serviço.
- **Secrets:** nunca em ConfigMap; Secret com criptografia em repouso ou External Secrets Operator; rotação dispara novo deployment.
- **Control plane separado** do plano de dados dos clientes.

---

## 8. GitHub integration

- **GitHub App** (não OAuth App): permissões granulares, tokens de instalação de 1h, rate limit por instalação.
- Permissões: `contents: read`, `metadata: read`, `pull_requests: read`, `checks: write`, `deployments: write`, `statuses: write`.
- Eventos: `push`, `pull_request`, `installation`, `installation_repositories`.
- Login de usuário (identidade) separado da instalação (acesso aos repos).
- Webhooks: validação HMAC, idempotência por delivery ID, nunca confiar no payload para permissões.
- **PRs de fork não recebem secrets** e ficam bloqueados por padrão.
- Tokens de instalação gerados sob demanda, nunca persistidos.

**Mapeamento branch → ambiente** (globs ordenadas, configuráveis):
```text
main        → Production
develop     → Staging
feature/*   → Preview (fase 2)
```

**Preview por PR (fase 2):** `opened/synchronize` cria/atualiza `pr-N`; `closed` agenda remoção; comentário único no PR, editado a cada atualização; herda variáveis do Staging com sobrescrita.

**Status:** check runs "Build", "Deploy" e "Health" por deployment, com link para os logs. Commit ↔ deployment vinculados pelo SHA em todas as telas.

---

## 9. Observabilidade

**Logs**
- Agente por nó (Vector ou Fluent Bit) lê stdout/stderr e adiciona labels `project`, `env`, `instance`, `deployment_id`.
- Armazenamento: Loki ou VictoriaLogs no MVP; ClickHouse se a busca exigir.
- Build e runtime no mesmo pipeline, distinguidos por `stream=build|runtime`.
- Tail via SSE com cursor para reconexão.
- Retenção por plano; arquivamento em object storage.

**Métricas**
- CPU, memória, rede e disco do kubelet/cAdvisor (ou equivalente) → Prometheus/VictoriaMetrics.
- Restarts e uptime derivados de eventos do runtime.
- Métricas de aplicação via `OTEL_EXPORTER_OTLP_ENDPOINT` injetado como variável.
- Labels permitidos: `project`, `env`, `instance`. Nunca `commit` ou `deployment_id`.

**Saúde:** status de deployment (máquina de estados) separado do status de runtime (`running`, `crashlooping`, `sleeping`, `stopped`). Erros passam por um tradutor para linguagem humana com sugestão de ação.

**Plataforma:** traces OpenTelemetry por job; métricas de fila; SLOs de tempo de deploy e de build.

---

## 10. API

REST com OpenAPI como contrato. CLI e web consomem a mesma API.

```text
GET    /v1/projects
POST   /v1/projects
GET    /v1/projects/{project}/environments
POST   /v1/projects/{project}/services
PUT    /v1/projects/{project}/environments/{env}/services/{svc}/config

GET    /v1/services/{instance}/deployments
POST   /v1/services/{instance}/deployments            (redeploy)
POST   /v1/deployments/{id}:rollback
POST   /v1/deployments/{id}:cancel
GET    /v1/deployments/{id}/logs?stream=build|runtime (SSE)

GET    /v1/services/{instance}/variables
PUT    /v1/services/{instance}/variables/{key}
POST   /v1/services/{instance}/domains
GET    /v1/services/{instance}/metrics?from=&to=&metric=

POST   /v1/github/webhooks
GET    /v1/operations/{id}
```

**Convenções**
- Ações como `:verbo` quando não são CRUD.
- `Idempotency-Key` em POSTs que criam recursos ou disparam jobs.
- Operações longas retornam `202` com `operation_id`.
- Paginação por cursor; erros em RFC 9457 (`problem+json`) com `code` estável.
- Versionamento por path (`/v1`).
- API tokens com escopo e expiração.
- Rate limit por token e por organização.

**CLI:** `login` (device flow), `init`, `deploy`, `logs`, `status`, `rollback`, `env`, `domain`.

---

## 11. Information architecture (frontend)

```text
Sidebar
├── Projects
│   └── Project
│       ├── Canvas (visão padrão: serviços e conexões do ambiente)
│       ├── Environments [switcher: Production | Staging | Preview-N]
│       ├── Services → Service detail
│       │     ├── Deployments (commit, autor, status, rollback)
│       │     ├── Logs (build | runtime, busca, tail)
│       │     ├── Metrics (CPU, RAM, rede, restarts, uptime)
│       │     ├── Variables (herança visível, secrets mascarados)
│       │     ├── Networking (domínios, portas, rede interna)
│       │     └── Settings (fonte, branch rules, recursos, health check, root dir)
│       ├── Volumes & Backups
│       └── Project settings (ambientes, membros, integrações)
├── New (wizard: Repo → Branch → Detecção → Confirmação → Deploy)
├── Integrations (GitHub App)
├── Team & Access
├── Usage & Billing
└── Audit log
```

- Wizard com revisão final do que foi detectado e do que será criado.
- Configuração progressiva: básico visível, "Avançado" colapsado.
- Canvas: nós = serviços, arestas = conexões (injetam variáveis). Visualização primeiro; edição depois.
- Drawer de deployment: commit, diff de variáveis vs. versão anterior, logs e rollback.

---

## 12. Riscos técnicos

| # | Risco | Impacto | Mitigação |
|---|---|---|---|
| 1 | Código de build escapando do sandbox | Crítico | microVM para builds, egress restrito, nós dedicados, sem privilégios |
| 2 | Vazamento de secrets | Crítico | Mascaramento, criptografia de envelope, bloqueio de forks |
| 3 | Runtime escolhido errado | Alto | `RuntimeAdapter`; spike com A e B |
| 4 | Custo de egress e logs acima da receita | Alto | Quotas, retenção limitada, usage desde o dia 1, sleep |
| 5 | Modelo serviço vs instância errado | Alto | `ServiceInstance` desde o início |
| 6 | Estado desejado divergindo do real | Alto | Reconciliador idempotente; GC de órfãos |
| 7 | Rate limit de Let's Encrypt/DNS | Médio | Wildcard, reuso de certificados, fila de emissão |
| 8 | Rate limit do GitHub | Médio | Tokens por instalação, cache, webhooks |
| 9 | Backup insuficiente de Postgres/Redis | Crítico | Backup automatizado, teste de restore, avisos na UI |
| 10 | Rollback quebrado por migração ou env | Alto | Snapshot imutável; aviso de migração; pre-deploy command |
| 11 | Detecção errada | Médio | Justificativa visível, override, corpus de testes |
| 12 | Abuso (mineração, spam) | Alto | Quotas, verificação de conta, detecção de padrões |
| 13 | Volume de logs derrubando o pipeline | Alto | Rate limit por instância, sampling em pico |
| 14 | LGPD e residência de dados | Alto | Região explícita; DPA; mínimo de dados pessoais em logs |
| 15 | Canvas atrasando o produto | Médio | Visualização primeiro; editor depois |
