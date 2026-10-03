# Roadmap

Ver `architecture.md` para o desenho técnico.

---

## Decisões a tomar antes da Fase 1

1. ~~**Runtime:**~~ **Decidido: k3s** atrás de `RuntimeAdapter`. Ver `architecture.md` §7.1.
2. **Cloud e região:** São Paulo (latência e LGPD) ou global desde o início.
3. ~~**Stack:**~~ **Decidido: TypeScript de ponta a ponta.** Fastify + Zod (API e OpenAPI), Drizzle + Postgres, BullMQ + Redis (fila de jobs), `@kubernetes/client-node` (runtime), React + Vite (web), CLI em Node, pnpm + Turborepo.
4. **Postgres/Redis dos clientes:** containers com volume ou serviço gerenciado atrás da mesma API.
5. **Tamanho do time e prazo** do MVP.
6. **Open source ou não:** self-hosting muda requisitos de multi-tenancy e instalação.

---

## Fase 0 — Spike técnico (2–3 semanas)

**Fora de escopo nesta fase:** autenticação. O spike roda sem login, provedor externo e RBAC; o acesso é local e restrito ao ambiente de teste. Auth volta na Fase 1.

- Pipeline ponta a ponta manual: repo Node → build em sandbox → imagem → workload → URL com HTTPS.
- Subir um cluster k3s e validar com um app real: deploy, NetworkPolicy entre namespaces e isolamento de build.
- Validar o detector com 30–50 repos públicos por linguagem.
- **Saída:** decisão de runtime, stack confirmada, rascunho do modelo de dados.

## Fase 1 — Fundações (4–6 semanas)

- Monorepo com módulos: `api`, `web`, `workers`, `cli`, `shared`.
- Auth, organizações, projetos, ambientes; API v1 com OpenAPI.
- Modelo de dados completo (mesmo que parte das tabelas ainda não seja usada).
- Fila de jobs, máquina de estados de deployment, reconciliador.
- `RuntimeAdapter` com a implementação inicial.

## Fase 2 — MVP (6–8 semanas)

- GitHub App: instalação, webhooks, checks.
- Build e detecção: Dockerfile, Node, Python, Go.
- Deploy, redeploy, rollback, health checks, restarts.
- Variáveis com herança, referências e snapshot.
- Logs em tempo real e métricas básicas.
- Domínio automático e custom domain com TLS.
- Templates de Postgres e Redis com backup diário.
- Web (dashboard, wizard, deployments, logs, variáveis) e CLI mínima.
- Beta fechado com 10–20 usuários.

**Critério de aceite:** em um repo Node típico, do "Connect GitHub" até URL pública com HTTPS, sem editar arquivos, em menos de 5 minutos no caminho feliz.

**Fora do MVP:** preview environments, canvas editável, workers, cron, object storage, volumes genéricos, autoscaling, billing, multi-região, private networking entre projetos, Java/PHP dedicados, SSO.

## Fase 3 — Hardening (3–4 semanas)

- Testes de isolamento: escape de build, acesso a metadados, vazamento de secrets.
- Quotas, rate limiting, prevenção de abuso.
- Teste de restore de backup; runbooks de incidente.
- Observabilidade da plataforma e SLOs.
- Revisão de LGPD e termos.

## Fase 4 — Produto (contínuo)

- Preview environments por PR.
- Cron jobs, workers, object storage.
- Java/Spring Boot e PHP via Buildpacks.
- Canvas editável.
- Billing sobre `usage_events` (após período de dados confiáveis).
- Autoscaling e multi-região conforme demanda real.

## Fase 5 — Plataforma

- Marketplace de templates.
- Webhooks e extensões.
- Import de Heroku/Render/Railway.
- Ambientes efêmeros para CI.

---

> Estimativas assumem time de 3–5 pessoas. Com time menor, reduzir o MVP para Dockerfile + Node e alongar a Fase 2.
