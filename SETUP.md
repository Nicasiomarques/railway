# railway-like — Quick Start

## One-Command Setup

```bash
# First time (installs everything, provisions infra, starts dev servers)
./setup.sh

# With gVisor + seed + tests
./setup.sh --full

# Skip infra (assume PostgreSQL, Redis, k3d already running)
./setup.sh --no-infra
```

**Opens automatically:**

- **API**: http://localhost:3000
- **Web**: http://localhost:5173
- **API Docs**: http://localhost:3000/docs

---

## What `setup.sh` Does

1. **Checks prerequisites** — Node.js 22+, pnpm, Docker, k3d, kubectl
2. **Installs PostgreSQL** (Ubuntu: apt+systemd | macOS: Homebrew)
3. **Creates databases** — `railway_like`, `railway_like_test`, `railway_like_workers_test`
4. **Starts Redis** (Docker)
5. **Creates k3d cluster + registry**
6. **Generates `api/.env`** with secure `ENCRYPTION_KEYS`
7. **Runs migrations** (Drizzle)
8. **Builds shared packages** (`@railway-like/shared`, `@railway-like/db`)
9. **Starts dev servers** — API (tsx), Web (Vite), Workers (Node + K8s env)
10. **Health checks** + prints summary with PIDs

---

## Stop & Cleanup

```bash
# Stop dev processes only (API, Web, Workers)
./stop.sh

# + Stop infrastructure (k3d, Redis, PostgreSQL)
./stop.sh --clean

# Nuclear: everything above + delete k3d cluster/registry, drop DBs, remove node_modules/dist
./stop.sh --full-clean
```

---

## Daily Workflow

```bash
# Morning
./setup.sh --no-infra   # Fast restart (10-15s)

# ... develop ...

# Evening
./stop.sh               # Stop dev, keep infra/data
```

---

## Requirements

| OS                | Prerequisites                                      |
| ----------------- | -------------------------------------------------- |
| **Ubuntu/Debian** | `sudo` access (script installs PostgreSQL via apt) |
| **macOS**         | Homebrew                                           |
| **Both**          | Docker Desktop running                             |

---

## Troubleshooting

| Issue                  | Fix                                                          |
| ---------------------- | ------------------------------------------------------------ |
| Port in use            | `lsof -ti:3000,5173,5432,6379,5050 \| xargs kill -9`         |
| PostgreSQL auth failed | Script configures `md5` auth automatically on Linux          |
| k3d cluster stuck      | `./stop.sh --clean && ./setup.sh`                            |
| Beekeeper connection   | Use `postgres://railway:railway@127.0.0.1:5432/railway_like` |

---

## Files Created by `setup.sh`

| File                                 | Purpose                                    |
| ------------------------------------ | ------------------------------------------ |
| `api/.env`                           | API config (auto-generated encryption key) |
| `/tmp/railway-{api,web,workers}.pid` | Process IDs for `stop.sh`                  |
| `/tmp/workers-env.sh`                | K8s env vars for workers                   |

---

## Manual Commands (if needed)

```bash
# Build all
pnpm build

# Typecheck all
pnpm typecheck

# Test all
pnpm test

# Database migrations (api/)
cd api && pnpm db:migrate
cd api && pnpm db:seed
```
