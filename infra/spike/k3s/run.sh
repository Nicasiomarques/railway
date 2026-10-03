#!/usr/bin/env bash
# Spike Fase 0: isolamento entre ambientes no k3s (architecture.md §7.2).
# Cria dois ambientes (namespaces) com um app real em cada um e NetworkPolicy default-deny.
# Verifica: tráfego dentro do ambiente passa; tráfego entre ambientes é bloqueado.
#
# Armadilha conhecida: o kube-router leva alguns segundos para programar o IP de um pod novo.
# Por isso o cliente é um pod persistente, e os negativos só são avaliados depois que o
# positivo do próprio ambiente passa (prova de que a política já está programada).
set -euo pipefail

CTX="${KUBE_CONTEXT:-k3d-railway-dev}"
K="kubectl --context $CTX"
ENVS=(env-a env-b)
APP_IMAGE="nginxinc/nginx-unprivileged:1.27-alpine"
CLIENT_IMAGE="curlimages/curl:8.11.1"
FAILURES=0

http_code() { # <namespace> <url> -> código HTTP, ou 000 se não conectou
  $K -n "$1" exec client -- curl -s -m 5 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null || true
}

wait_allowed() { # <namespace> <url> -> espera até o tráfego do próprio ambiente passar
  local ns="$1" url="$2" code
  for _ in $(seq 1 30); do
    code=$(http_code "$ns" "$url")
    [[ "$code" == 2* ]] && return 0
    sleep 3
  done
  return 1
}

check() { # check <descrição> <ALLOWED|BLOCKED> <namespace> <url>
  local desc="$1" expected="$2" ns="$3" url="$4" code result
  code=$(http_code "$ns" "$url")
  if [[ "$code" == 2* ]]; then result=ALLOWED; else result=BLOCKED; fi
  if [[ "$result" == "$expected" ]]; then
    echo "PASS  $desc (HTTP $code)"
  else
    echo "FAIL  $desc: esperado $expected, obtido $result (HTTP $code)"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "== namespaces com perfil restricted"
for ns in "${ENVS[@]}"; do
  $K create namespace "$ns" --dry-run=client -o yaml | $K apply -f - >/dev/null
  $K label namespace "$ns" pod-security.kubernetes.io/enforce=restricted platform/env="$ns" --overwrite >/dev/null
done

echo "== app, cliente e NetworkPolicy em cada ambiente"
for ns in "${ENVS[@]}"; do
  $K apply -n "$ns" -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello
  labels: {app: hello, platform/env: $ns}
spec:
  replicas: 1
  selector: {matchLabels: {app: hello}}
  template:
    metadata:
      labels: {app: hello, platform/env: $ns}
    spec:
      securityContext: {runAsNonRoot: true, runAsUser: 1000, seccompProfile: {type: RuntimeDefault}}
      containers:
        - name: app
          image: $APP_IMAGE
          ports: [{containerPort: 8080}]
          securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
          volumeMounts:
            - {name: tmp, mountPath: /tmp}
            - {name: cache, mountPath: /var/cache/nginx}
      volumes:
        - {name: tmp, emptyDir: {}}
        - {name: cache, emptyDir: {}}
---
apiVersion: v1
kind: Service
metadata: {name: hello}
spec:
  selector: {app: hello}
  ports: [{port: 8080, targetPort: 8080}]
---
apiVersion: v1
kind: Pod
metadata:
  name: client
  labels: {app: client, platform/env: $ns}
spec:
  securityContext: {runAsNonRoot: true, runAsUser: 1000, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: client
      image: $CLIENT_IMAGE
      command: [sleep, "86400"]
      securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
---
# Default-deny: nada entra nem sai sem regra explícita.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: default-deny}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
# Tráfego entre pods do mesmo ambiente (seletor de namespace explícito).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: allow-same-env}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: $ns}}
  egress:
    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: $ns}}
---
# DNS para o kube-dns.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: allow-dns}
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
      ports:
        - {port: 53, protocol: UDP}
        - {port: 53, protocol: TCP}
---
# Internet liberada, exceto redes privadas do cluster e o endpoint de metadados de nuvem.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: allow-internet-egress}
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
              - 169.254.169.254/32
YAML
done

echo "== aguardando app e cliente"
for ns in "${ENVS[@]}"; do
  $K -n "$ns" rollout status deploy/hello --timeout=120s >/dev/null
  $K -n "$ns" wait --for=condition=Ready pod/client --timeout=120s >/dev/null
done

echo "== aguardando a política de cada ambiente ficar ativa"
for ns in "${ENVS[@]}"; do
  if wait_allowed "$ns" "http://hello.$ns.svc.cluster.local:8080/"; then
    echo "OK    $ns: app responde ao próprio cliente"
  else
    echo "FAIL  $ns: app não respondeu ao próprio cliente em 90s"
    FAILURES=$((FAILURES + 1))
  fi
done

echo "== verificações de isolamento"
for ns in "${ENVS[@]}"; do
  check "$ns acessa o próprio app pelo Service" ALLOWED "$ns" "http://hello.$ns.svc.cluster.local:8080/"
done
check "env-b NÃO acessa o app de env-a pelo Service" BLOCKED env-b "http://hello.env-a.svc.cluster.local:8080/"
check "env-a NÃO acessa o app de env-b pelo Service" BLOCKED env-a "http://hello.env-b.svc.cluster.local:8080/"
for ns in "${ENVS[@]}"; do
  other=$([[ "$ns" == env-a ]] && echo env-b || echo env-a)
  ip=$($K -n "$other" get pod -l app=hello -o jsonpath='{.items[0].status.podIP}')
  check "$ns NÃO alcança o IP do pod de $other" BLOCKED "$ns" "http://$ip:8080/"
done

echo
if [[ $FAILURES -eq 0 ]]; then echo "SPIKE OK: isolamento validado."; else echo "SPIKE FALHOU: $FAILURES verificação(ões)."; exit 1; fi
