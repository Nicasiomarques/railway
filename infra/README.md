# Ambiente local de desenvolvimento

Setup manual até existir um `docker-compose` e um CI. Tudo abaixo roda no Docker Desktop.

## Serviços

| Serviço | Como subir | Porta no host |
|---|---|---|
| Postgres | instalação local (Homebrew) | 5432 |
| Redis | `docker run -d --name railway-redis -p 6379:6379 redis:7-alpine` | 6379 |
| Cluster k3s | `k3d cluster create railway-dev --agents 1 --registry-use k3d-railway-reg:5000 --wait` | — |
| Registry | `k3d registry create railway-reg --port 5050` | 5050 |

Notas:
- A porta 5000 costuma estar ocupada no macOS (AirPlay). Por isso o registry usa 5050 no host.
- Dentro do cluster, o registry é `k3d-railway-reg:5000` (é o que os nós puxam e o que o build publica).
- Do host, o mesmo registry é `localhost:5050`.

## Repo de teste para builds

Os pods clonam por HTTP, então o repo precisa ser servido de algum lugar que o cluster alcança:

```bash
git clone --bare <repo> /tmp/build-src/app.git
git -C /tmp/build-src/app.git update-server-info
python3 -m http.server 8189 --bind 0.0.0.0 --directory /tmp/build-src
```

No cluster, o host aparece como `host.k3d.internal`. A URL do repo fica `http://host.k3d.internal:8189/app.git`.

## Bancos de teste

- `railway_like` — dev da API.
- `railway_like_test` — testes da API.
- `railway_like_workers_test` — testes e E2E dos workers. Só um role com permissão de criar banco consegue criá-lo: `createdb -U postgres railway_like_workers_test`.

Migrações: `DATABASE_URL=... npx drizzle-kit migrate` dentro de `api/`, para cada banco.

## Variáveis

- API: `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEYS`, `ENCRYPTION_CURRENT_KID`, `PORT`.
- Workers: as mesmas de criptografia e Redis, mais `RECONCILER_RUNTIME=k8s`, `K8S_CONTEXT`, `BUILD_REGISTRY=k3d-railway-reg:5000`.

## Limitações conhecidas

- Builds exigem seccomp `Unconfined` e `allowPrivilegeEscalation` no container de build, por causa do BuildKit rootless. O namespace `builds` tem PSA `privileged`. Isso é a principal concessão de segurança do projeto; o isolamento real (microVM ou gVisor) ainda é spike.
- Não há política de egress nos namespaces `builds`.

## Egress dos builds

Os namespaces `builds` bloqueiam redes privadas. Para o build alcançar o registry e o repo de teste, configure:

```bash
export BUILD_EGRESS_ALLOW=172.24.0.2/32:5000,192.168.65.254/32:8189
```

- `172.24.0.2` é o IP do registry na rede do k3d (confira com `docker inspect k3d-railway-reg`).
- `192.168.65.254` é o `host.k3d.internal` do Docker Desktop (confira com `nslookup host.k3d.internal` de dentro de um pod).

Um gate de init container espera a política estar ativa antes do clone, porque o kube-router a programa com atraso no início do pod.

## Sandbox do build (gVisor)

Os builds rodam por padrão com `RuntimeClass gvisor`. Para instalar nos nós do k3d:

```bash
infra/spike/gvisor/install.sh
```

Padrões do worker: `BUILD_RUNTIME_CLASS=gvisor`, sandbox de processo do BuildKit ligado, snapshotter nativo (`--oci-worker-snapshotter=native`). Para desligar: `BUILD_RUNTIME_CLASS=""` (runtime padrão) ou `BUILD_PROCESS_SANDBOX=none`.

Detalhes e o que ainda exige concessões: `infra/spike/gvisor/README.md`.

## Provisionamento de ambiente

Job `provision-environment` (saga em `workers/src/provisioning/`), com estado em `environments.provisioning_*`. Passos, nesta ordem, todos upserts idempotentes:

1. `namespace`: `env-<environmentId>` com labels `platform/project`, `platform/env` e PSA `restricted`.
2. `default-deny-policy`: NetworkPolicy que nega ingress e egress de todos os pods do namespace.
3. `quota`: LimitRange (padrão por contêiner: request 100m/128Mi, limite 500m/512Mi) e ResourceQuota (requests 2 CPU/4Gi, limites 4 CPU/8Gi, 20 pods).

Verificado no k3d com `K8S_TEST_CONTEXT=k3d-railway-dev`: um workload sem `resources` sobe dentro do ambiente com os padrões da LimitRange.

Ainda não ligado:
- Nenhuma rota da API cria ambientes, e nada enfileira o job. Hoje o ambiente entra só pelo seed.
- O reconciliador não espera a saga terminar: um workload pode ser aplicado antes do namespace ter as políticas.
- A política de egress nega DNS e internet. Liberações (DNS, edge, tráfego entre serviços, egress) ainda não existem; um app que resolve nomes externos não foi testado nesse estado.
- Não há escopo de secrets no store de segredos (passo "secret store" de architecture.md §6): os segredos ficam cifrados por envelope no Postgres.

## DNS dos nomes do host

`host.k3d.internal` deixou de resolver dentro do cluster depois de reiniciar os nós (para instalar o gVisor). Use o IP do host nos repos de teste e em `BUILD_EGRESS_ALLOW`: `192.168.65.254` no Docker Desktop. Confira com `nslookup host.k3d.internal` de dentro de um pod.
