#!/usr/bin/env bash
# Stop all railway-like dev processes and clean up infrastructure
# Usage: ./stop.sh [--clean] [--full-clean] [--help]
#   --clean      : Stop infra (k3d, Redis, PostgreSQL)
#   --full-clean : + Drop databases, remove node_modules, dist, k3d cluster/registry
#   --help       : Show this help

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="railway-dev"
REGISTRY_NAME="railway-reg"
PG_DB="railway_like"
PG_TEST_DB="railway_like_test"
PG_WORKERS_TEST_DB="railway_like_workers_test"

log() { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
ok()  { echo -e "\033[1;32m[OK]\033[0m   $*"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
err()  { echo -e "\033[1;31m[ERR]\033[0m   $*" >&2; }

cmd_exists() { command -v "$1" >/dev/null 2>&1; }

# ─── Parse args ──────────────────────────────────────────────────────────
CLEAN=false
FULL_CLEAN=false
for arg in "$@"; do
  case $arg in
    --clean)      CLEAN=true ;;
    --full-clean) CLEAN=true; FULL_CLEAN=true ;;
    --help|-h)
      grep '^# Usage:' "$0" | cut -c3-
      exit 0
      ;;
    *) err "Unknown argument: $arg (use --help)"; exit 1 ;;
  esac
done

# ─── 1. Kill dev processes (API, Web, Workers) ───────────────────────────
log "Stopping development processes..."

# Print a PID and all of its descendants (subshell -> pnpm -> node/vite/tsx).
# Killing only the subshell from the PID file leaves its children running.
list_tree() {
  local pid=$1 child
  echo "$pid"
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    list_tree "$child"
  done
}

for name in api web workers; do
  pid_file="/tmp/railway-$name.pid"
  if [[ -f "$pid_file" ]]; then
    pid=$(cat "$pid_file" 2>/dev/null || echo "")
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      log "Stopping $name (PID: $pid)..."
      tree=$(list_tree "$pid")
      # TERM the whole tree, then KILL whatever survived
      # shellcheck disable=SC2086
      kill $tree 2>/dev/null || true
      sleep 1
      # shellcheck disable=SC2086
      kill -9 $tree 2>/dev/null || true
      ok "$name stopped"
    fi
    rm -f "$pid_file"
  fi
done

# Fallback: orphaned processes from THIS project only (argv contains <root>/...node_modules/).
# Never use generic patterns like "pnpm.*dev" here — they kill other projects too.
pkill -f "$ROOT/.*node_modules/" 2>/dev/null || true

# Clean temp files created by setup.sh
rm -f /tmp/workers-env.sh
rm -f /tmp/railway-*.pid
ok "Development processes stopped"

# ─── 2. Infrastructure cleanup ───────────────────────────────────────────
if [[ "$CLEAN" == true ]]; then
  log "Stopping infrastructure..."

  # k3d cluster
  if cmd_exists k3d; then
    if k3d cluster list 2>/dev/null | grep -q "$CLUSTER_NAME"; then
      if [[ "$FULL_CLEAN" == true ]]; then
        log "Deleting k3d cluster '$CLUSTER_NAME'..."
        k3d cluster delete "$CLUSTER_NAME" >/dev/null 2>&1 || true
        ok "k3d cluster deleted"
      else
        log "Stopping k3d cluster '$CLUSTER_NAME'..."
        k3d cluster stop "$CLUSTER_NAME" >/dev/null 2>&1 || true
        ok "k3d cluster stopped"
      fi
    fi

    # k3d registry
    if k3d registry list 2>/dev/null | grep -q "$REGISTRY_NAME"; then
      log "Deleting k3d registry '$REGISTRY_NAME'..."
      k3d registry delete "$REGISTRY_NAME" >/dev/null 2>&1 || true
      ok "Registry deleted"
    fi
  fi

  # Redis container
  if cmd_exists docker; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^railway-redis$"; then
      log "Stopping Redis container..."
      docker stop railway-redis >/dev/null 2>&1 || true
      docker rm railway-redis >/dev/null 2>&1 || true
      ok "Redis container removed"
    fi
    # Also remove any dangling railway-like containers
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E "^railway-" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi

  # PostgreSQL
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS: Homebrew
    if cmd_exists brew; then
      log "Stopping PostgreSQL (Homebrew)..."
      brew services stop postgresql@16 2>/dev/null || brew services stop postgresql 2>/dev/null || true
      ok "PostgreSQL stopped"
    fi
  else
    # Linux: systemd
    if cmd_exists systemctl && systemctl is-active --quiet postgresql 2>/dev/null; then
      if [[ "$FULL_CLEAN" == true ]]; then
        log "Stopping PostgreSQL service..."
        sudo systemctl stop postgresql 2>/dev/null || true
        sudo systemctl disable postgresql 2>/dev/null || true
        ok "PostgreSQL stopped and disabled"
      else
        log "Stopping PostgreSQL service..."
        sudo systemctl stop postgresql 2>/dev/null || true
        ok "PostgreSQL stopped"
      fi
    fi
  fi

  # gVisor RuntimeClass (clean up K8s resource)
  if cmd_exists kubectl; then
    CTX="k3d-$CLUSTER_NAME"
    if kubectl config get-contexts -o name 2>/dev/null | grep -q "^$CTX$"; then
      if kubectl --context "$CTX" get runtimeclass gvisor >/dev/null 2>&1; then
        log "Removing gVisor RuntimeClass..."
        kubectl --context "$CTX" delete runtimeclass gvisor >/dev/null 2>&1 || true
        ok "gVisor RuntimeClass removed"
      fi
    fi
  fi
fi

# ─── 3. Full clean: drop databases, remove build artifacts ───────────────
if [[ "$FULL_CLEAN" == true ]]; then
  log "Removing all data (databases, node_modules, build artifacts, k3d data)..."

  # Drop databases
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS: dropdb (uses current user)
    if cmd_exists dropdb; then
      for db in "$PG_DB" "$PG_TEST_DB" "$PG_WORKERS_TEST_DB"; do
        dropdb "$db" 2>/dev/null || true
      done
      ok "Databases dropped"
    fi
  else
    # Linux: sudo -u postgres dropdb
    if cmd_exists psql && sudo -u postgres psql -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "$PG_DB"; then
      log "Dropping PostgreSQL databases..."
      for db in "$PG_DB" "$PG_TEST_DB" "$PG_WORKERS_TEST_DB"; do
        sudo -u postgres dropdb "$db" 2>/dev/null || true
      done
      # Drop user
      sudo -u postgres psql -c "DROP USER IF EXISTS railway;" 2>/dev/null || true
      ok "Databases and user dropped"
    fi
  fi

  # Remove node_modules and build artifacts
  log "Removing node_modules and dist folders..."
  cd "$ROOT"
  rm -rf node_modules
  rm -rf api/node_modules api/dist
  rm -rf web/node_modules web/dist
  rm -rf workers/node_modules workers/dist
  rm -rf cli/node_modules cli/dist
  rm -rf db/node_modules db/dist
  rm -rf shared/node_modules shared/dist
  ok "Build artifacts removed"

  # Remove generated .env (optional - keep for convenience)
  # rm -f "$ROOT/api/.env"

  ok "Full cleanup complete"
fi

echo
ok "All done. Run ./setup.sh to start fresh."