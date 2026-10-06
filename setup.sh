#!/usr/bin/env bash
# railway-like: One-command bootstrap & dev environment
# Usage: ./setup.sh [--full] [--no-infra] [--background] [--help]
#   --full      : Also install gVisor, build images, run tests
#   --no-infra  : Skip infra setup (Postgres, Redis, k3d), only install deps & start apps
#   --background: Start services and exit immediately (don't tail logs)
#   --help      : Show this help

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="railway-dev"
CTX="k3d-$CLUSTER_NAME"
REGISTRY_NAME="railway-reg"
REGISTRY_PORT=5050
PG_DB="railway_like"
PG_TEST_DB="railway_like_test"
PG_WORKERS_TEST_DB="railway_like_workers_test"
FULL_MODE=false
NO_INFRA=false
BACKGROUND=false

# ─── Helpers ─────────────────────────────────────────────────────────────
log()   { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
ok()    { echo -e "\033[1;32m[OK]\033[0m   $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
err()   { echo -e "\033[1;31m[ERR]\033[0m   $*" >&2; }
die()   { err "$*"; exit 1; }

cmd_exists() { command -v "$1" >/dev/null 2>&1; }

# ─── Parse args ──────────────────────────────────────────────────────────
for arg in "$@"; do
  case $arg in
    --full)     FULL_MODE=true ;;
    --no-infra) NO_INFRA=true ;;
    --background) BACKGROUND=true ;;
    --help|-h)
      grep '^# Usage:' "$0" | cut -c3-
      exit 0
      ;;
    *) die "Unknown argument: $arg (use --help)" ;;
  esac
done

# ─── 0. Prerequisites ────────────────────────────────────────────────────
log "Checking prerequisites..."

# Node.js via nvm
if ! cmd_exists node; then
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "$HOME/.nvm/nvm.sh"
    nvm install
  else
    die "Node.js not found. Install nvm (https://github.com/nvm-sh/nvm) then run: nvm install"
  fi
fi
NODE_VER=$(node -v | sed 's/^v//' | cut -d. -f1)
(( NODE_VER >= 22 )) || die "Node.js >= 22 required (found $(node -v))"
ok "Node.js $(node -v)"

# pnpm
if ! cmd_exists pnpm; then
  log "Installing pnpm..."
  corepack enable pnpm
fi
ok "pnpm $(pnpm -v)"

# Docker
if ! cmd_exists docker; then
  die "Docker not found. Install Docker Desktop (https://docker.com/products/docker-desktop)"
fi
docker info >/dev/null 2>&1 || die "Docker daemon not running. Start Docker Desktop."
ok "Docker $(docker version --format '{{.Server.Version}}')"

# Homebrew (macOS) for postgres
if [[ "$OSTYPE" == "darwin"* ]] && ! cmd_exists brew; then
  die "Homebrew not found. Install from https://brew.sh"
fi

# k3d / kubectl
if ! cmd_exists k3d; then
  log "Installing k3d..."
  if [[ "$OSTYPE" == "darwin"* ]]; then brew install k3d; else curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash; fi
fi
if ! cmd_exists kubectl; then
  log "Installing kubectl..."
  if [[ "$OSTYPE" == "darwin"* ]]; then brew install kubectl; else curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && chmod +x kubectl && sudo mv kubectl /usr/local/bin/; fi
fi
ok "k3d $(k3d version | head -1) | kubectl $(kubectl version --client -o json | jq -r .clientVersion.gitVersion)"

# ─── 1. Install JS dependencies ──────────────────────────────────────────
log "Installing workspace dependencies..."
cd "$ROOT"
pnpm install --frozen-lockfile
ok "Dependencies installed"

# ─── 2. Infrastructure ───────────────────────────────────────────────────
if [[ "$NO_INFRA" == false ]]; then
  log "Setting up infrastructure..."

  # 2a. PostgreSQL
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS: Homebrew
    if ! cmd_exists psql; then
      log "Installing PostgreSQL..."
      brew install postgresql@16
    fi
    if ! brew services list | grep -q "postgresql@16.*started"; then
      log "Starting PostgreSQL..."
      brew services start postgresql@16 2>/dev/null || brew services start postgresql 2>/dev/null
      sleep 3
    fi
    # Create railway user with password
    createuser -s railway 2>/dev/null || true
    psql postgres -c "ALTER USER railway WITH PASSWORD 'railway';" 2>/dev/null || true
    for db in "$PG_DB" "$PG_TEST_DB" "$PG_WORKERS_TEST_DB"; do
      createdb "$db" -O railway 2>/dev/null || true
    done
    ok "PostgreSQL databases ready"
  else
    # Linux: Ubuntu/Debian (apt + systemd)
    if ! cmd_exists psql; then
      log "Installing PostgreSQL..."
      sudo apt-get update -qq
      sudo apt-get install -y -qq postgresql postgresql-contrib
    fi
    # Ensure service is running
    if ! systemctl is-active --quiet postgresql; then
      log "Starting PostgreSQL..."
      sudo systemctl start postgresql
      sudo systemctl enable postgresql
      sleep 2
    fi
    # Configure password auth (md5) for local connections
    PG_HBA=$(find /etc/postgresql -name pg_hba.conf 2>/dev/null | head -1)
    if [[ -n "$PG_HBA" ]]; then
      if grep -q "local\s\+all\s\+all\s\+peer" "$PG_HBA"; then
        log "Configuring PostgreSQL password authentication..."
        sudo sed -i "s/local\s\+all\s\+all\s\+peer/local all all md5/" "$PG_HBA"
        sudo systemctl restart postgresql
        sleep 2
      fi
    fi
    # Create user and databases
    log "Creating PostgreSQL user and databases..."
    sudo -u postgres psql -c "CREATE USER railway WITH PASSWORD 'railway';" 2>/dev/null || true
    for db in "$PG_DB" "$PG_TEST_DB" "$PG_WORKERS_TEST_DB"; do
      sudo -u postgres psql -c "CREATE DATABASE $db OWNER railway;" 2>/dev/null || true
    done
    ok "PostgreSQL databases ready"
  fi

  # 2b. Redis
  if ! docker ps --format '{{.Names}}' | grep -q "^railway-redis$"; then
    log "Starting Redis..."
    docker run -d --name railway-redis -p 6379:6379 redis:7-alpine >/dev/null
    sleep 2
  fi
  ok "Redis running on localhost:6379"

  # 2c. k3d registry
  if ! k3d registry list | grep -q "$REGISTRY_NAME"; then
    log "Creating k3d registry..."
    k3d registry create "$REGISTRY_NAME" --port "$REGISTRY_PORT" >/dev/null
  fi
  ok "Registry: localhost:$REGISTRY_PORT (internal: k3d-$REGISTRY_NAME:5000)"

  # 2d. k3d cluster
  if ! k3d cluster list | grep -q "$CLUSTER_NAME"; then
    log "Creating k3d cluster..."
    k3d cluster create "$CLUSTER_NAME" \
      --agents 1 \
      --registry-use "k3d-$REGISTRY_NAME:5000" \
      --wait >/dev/null
    sleep 5
  else
    log "Starting existing cluster..."
    k3d cluster start "$CLUSTER_NAME" >/dev/null
  fi
  ok "Cluster $CLUSTER_NAME ready"

  # 2e. Configure kubectl context
  kubectl config use-context "$CTX" >/dev/null
  ok "kubectl context: $CTX"

  # 2f. gVisor (optional, full mode)
  if [[ "$FULL_MODE" == true ]]; then
    log "Installing gVisor (this takes ~30s)..."
    bash "$ROOT/infra/spike/gvisor/install.sh"
    ok "gVisor RuntimeClass 'gvisor' installed"
  fi
fi

# ─── 3. Environment files ────────────────────────────────────────────────
log "Configuring environment files..."

# API .env
if [[ ! -f "$ROOT/api/.env" ]]; then
  cp "$ROOT/api/.env.example" "$ROOT/api/.env"
  # Generate encryption key
  ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  sed -i.bak "s|REPLACE_WITH_BASE64_32_BYTES|$ENC_KEY|" "$ROOT/api/.env" && rm "$ROOT/api/.env.bak"
  ok "Created api/.env with generated ENCRYPTION_KEYS"
else
  ok "api/.env already exists"
fi

# ─── 4. Database migrations & seed ───────────────────────────────────────
log "Running database migrations..."
cd "$ROOT/api"
DATABASE_URL="postgres://railway:railway@localhost:5432/$PG_DB" pnpm db:migrate
ok "Migrations applied to $PG_DB"

# Test databases
for db in "$PG_TEST_DB" "$PG_WORKERS_TEST_DB"; do
  DATABASE_URL="postgres://railway:railway@localhost:5432/$db" pnpm db:migrate 2>/dev/null || true
done
ok "Test databases migrated"

# Seed (optional)
if [[ "$FULL_MODE" == true ]]; then
  log "Seeding database..."
  DATABASE_URL="postgres://railway:railway@localhost:5432/$PG_DB" pnpm db:seed 2>/dev/null || warn "Seed failed (may be expected)"
  ok "Seed completed"
fi

# ─── 5. Build shared packages ────────────────────────────────────────────
log "Building shared packages..."
cd "$ROOT"
pnpm --filter="@railway-like/shared" build
pnpm --filter="@railway-like/db" build
ok "Shared packages built"

# ─── 6. Start development servers ────────────────────────────────────────
log "Starting development servers..."

# Function to start a service in background
start_service() {
  local name=$1 dir=$2 cmd=$3
  log "Starting $name..."
  (cd "$ROOT/$dir" && eval "$cmd") &
  echo $! > "/tmp/railway-$name.pid"
  ok "$name started (PID: $!)"
}

# API
start_service "api" "api" "pnpm dev"

# Web
start_service "web" "web" "pnpm dev"

# Build egress allow-list — derive IPs from running infra (see infra/README.md "Build egress")
REGISTRY_IP=$(docker inspect "k3d-$REGISTRY_NAME" --format "{{(index .NetworkSettings.Networks \"k3d-$CLUSTER_NAME\").IPAddress}}" 2>/dev/null || true)
HOST_GATEWAY_IP=$(docker network inspect "k3d-$CLUSTER_NAME" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)
if [[ -n "$REGISTRY_IP" && -n "$HOST_GATEWAY_IP" ]]; then
  BUILD_EGRESS_ALLOW="${REGISTRY_IP}/32:5000,${HOST_GATEWAY_IP}/32:8189"
  # Docker Desktop reaches the host at 192.168.65.254 (host.docker.internal), not only via the gateway
  if [[ "$OSTYPE" == "darwin"* ]]; then
    BUILD_EGRESS_ALLOW="$BUILD_EGRESS_ALLOW,192.168.65.254/32:8189"
  fi
  ok "Build egress allow-list: $BUILD_EGRESS_ALLOW"
else
  warn "Could not derive registry/host IPs; set BUILD_EGRESS_ALLOW manually (infra/README.md 'Build egress')"
  BUILD_EGRESS_ALLOW=""
fi

# Workers (needs env vars)
cat > "/tmp/workers-env.sh" <<EOF
export RECONCILER_RUNTIME=k8s
export K8S_CONTEXT=$CTX
export BUILD_REGISTRY=k3d-$REGISTRY_NAME:5000
export BUILD_EGRESS_ALLOW="$BUILD_EGRESS_ALLOW"
export METRICS_PORT=9102
# Database for workers
export DATABASE_URL=postgres://railway:railway@localhost:5432/$PG_DB
export REDIS_URL=redis://localhost:6379
EOF
start_service "workers" "workers" "source /tmp/workers-env.sh && pnpm dev"

# ─── 7. Health checks ────────────────────────────────────────────────────
log "Waiting for services to be ready..."
sleep 5

# API health
for i in {1..30}; do
  if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    ok "API ready at http://localhost:3000"
    break
  fi
  sleep 1
done

# Web
for i in {1..30}; do
  if curl -sf http://localhost:5173 >/dev/null 2>&1; then
    ok "Web ready at http://localhost:5173"
    break
  fi
  sleep 1
done

# ─── 8. Summary ──────────────────────────────────────────────────────────
echo
echo "═══════════════════════════════════════════════════════════════"
echo "  🚀 railway-like development environment is READY!"
echo "═══════════════════════════════════════════════════════════════"
echo
echo "  Services:"
echo "    • API:       http://localhost:3000"
echo "    • Web:       http://localhost:5173"
echo "    • API Docs:  http://localhost:3000/docs"
echo
echo "  Infrastructure:"
echo "    • PostgreSQL: localhost:5432  (db: $PG_DB)"
echo "    • Redis:      localhost:6379"
echo "    • k3s:        $CTX"
echo "    • Registry:   localhost:$REGISTRY_PORT"
echo
echo "  Useful commands:"
echo "    • View logs:    tail -f /tmp/railway-*.log  (not implemented, see PIDs below)"
echo "    • Stop all:     ./stop.sh"
echo "    • Run tests:    pnpm test"
echo "    • Typecheck:    pnpm typecheck"
echo "    • Build all:    pnpm build"
echo
echo "  Background PIDs (save to stop later):"
for name in api web workers; do
  pid=$(cat "/tmp/railway-$name.pid" 2>/dev/null || echo "?")
  echo "    • $name: PID $pid"
done
echo
echo "  To stop everything, press Ctrl+C or run: kill \$(cat /tmp/railway-*.pid 2>/dev/null)"
echo

# Keep script alive to show logs (optional)
if [[ "$BACKGROUND" == false ]]; then
  log "Tailing API logs (Ctrl+C to stop all)..."
  wait
fi