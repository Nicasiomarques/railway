#!/usr/bin/env bash
# Instala o gVisor (runsc) nos nós do cluster k3d e cria o RuntimeClass `gvisor`.
# Testado com k3s v1.35 em Docker Desktop (arm64). Os nós são imagens mínimas: os binários vão para /bin.
set -euo pipefail

CLUSTER="${CLUSTER:-railway-dev}"
CTX="k3d-$CLUSTER"
RELEASE="${GVISOR_RELEASE:-20251006}"
NODES=("k3d-$CLUSTER-server-0" "k3d-$CLUSTER-agent-0")
ARCH="$(docker exec "${NODES[0]}" uname -m)"
case "$ARCH" in
  aarch64) GV_ARCH=aarch64 ;;
  x86_64) GV_ARCH=x86_64 ;;
  *) echo "arquitetura não suportada: $ARCH" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
BASE="https://storage.googleapis.com/gvisor/releases/release/$RELEASE/$GV_ARCH"
for f in runsc containerd-shim-runsc-v1; do
  curl -fsSL -o "$WORK/$f" "$BASE/$f"
  curl -fsSL -o "$WORK/$f.sha512" "$BASE/$f.sha512"
  (cd "$WORK" && sha512sum -c "$f.sha512" >/dev/null)
  echo "checksum ok: $f ($RELEASE/$GV_ARCH)"
done

for node in "${NODES[@]}"; do
  docker cp "$WORK/runsc" "$node:/bin/runsc"
  docker cp "$WORK/containerd-shim-runsc-v1" "$node:/bin/containerd-shim-runsc-v1"
  docker exec "$node" chmod +x /bin/runsc /bin/containerd-shim-runsc-v1
  # k3s regenera config.toml a partir do template: o template inclui o base e acrescenta o runsc.
  docker exec "$node" sh -c 'cd /var/lib/rancher/k3s/agent/etc/containerd && {
    echo "{{ template \"base\" . }}"; echo "";
    echo "[plugins.'"'"'io.containerd.cri.v1.runtime'"'"'.containerd.runtimes.runsc]";
    echo "  runtime_type = \"io.containerd.runsc.v1\"";
  } > config.toml.tmpl'
  echo "nó configurado: $node"
done

for node in "${NODES[@]}"; do docker restart "$node" >/dev/null; done
sleep 25

cat > "$WORK/runtimeclass.yaml" <<'YAML'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
YAML
kubectl --context "$CTX" apply -f "$WORK/runtimeclass.yaml"
rm -rf "$WORK"
echo "gVisor instalado. Verifique com: kubectl --context $CTX -n default run gv --rm -it --restart=Never --image=alpine:3.20 --overrides='{\"spec\":{\"runtimeClassName\":\"gvisor\"}}' -- uname -a"
