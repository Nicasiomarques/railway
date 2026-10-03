#!/usr/bin/env bash
# Phase 0 spike: isolation between environments on k3s (architecture.md §7.2).
# Creates two environments (namespaces) with a real app in each, and a default-deny NetworkPolicy.
# Checks: traffic within the environment passes; traffic between environments is blocked.
#
# Known gotcha: kube-router takes a few seconds to program a new pod's IP. That's why the
# client is a persistent pod, and negatives are only evaluated after the environment's own
# positive passes (proof the policy is already programmed).
set -euo pipefail

CTX="${KUBE_CONTEXT:-k3d-railway-dev}"
K="kubectl --context $CTX"
ENVS=(env-a env-b)
APP_IMAGE="nginxinc/nginx-unprivileged:1.27-alpine"
CLIENT_IMAGE="curlimages/curl:8.11.1"
FAILURES=0

http_code() { # <namespace> <url> -> HTTP code, or 000 if it didn't connect
  $K -n "$1" exec client -- curl -s -m 5 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null || true
}

wait_allowed() { # <namespace> <url> -> waits until the environment's own traffic passes
  local ns="$1" url="$2" code
  for _ in $(seq 1 30); do
    code=$(http_code "$ns" "$url")
    [[ "$code" == 2* ]] && return 0
    sleep 3
  done
  return 1
}

check() { # check <description> <ALLOWED|BLOCKED> <namespace> <url>
  local desc="$1" expected="$2" ns="$3" url="$4" code result
  code=$(http_code "$ns" "$url")
  if [[ "$code" == 2* ]]; then result=ALLOWED; else result=BLOCKED; fi
  if [[ "$result" == "$expected" ]]; then
    echo "PASS  $desc (HTTP $code)"
  else
    echo "FAIL  $desc: expected $expected, got $result (HTTP $code)"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "== namespaces with the restricted profile"
for ns in "${ENVS[@]}"; do
  $K create namespace "$ns" --dry-run=client -o yaml | $K apply -f - >/dev/null
  $K label namespace "$ns" pod-security.kubernetes.io/enforce=restricted platform/env="$ns" --overwrite >/dev/null
done

echo "== app, client and NetworkPolicy in each environment"
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
# Default-deny: nothing goes in or out without an explicit rule.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: default-deny}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
# Traffic between pods in the same environment (explicit namespace selector).
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
# DNS to kube-dns.
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
# Internet allowed, except the cluster's private networks and the cloud metadata endpoint.
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

echo "== waiting for the app and client"
for ns in "${ENVS[@]}"; do
  $K -n "$ns" rollout status deploy/hello --timeout=120s >/dev/null
  $K -n "$ns" wait --for=condition=Ready pod/client --timeout=120s >/dev/null
done

echo "== waiting for each environment's policy to become active"
for ns in "${ENVS[@]}"; do
  if wait_allowed "$ns" "http://hello.$ns.svc.cluster.local:8080/"; then
    echo "OK    $ns: app responds to its own client"
  else
    echo "FAIL  $ns: app did not respond to its own client within 90s"
    FAILURES=$((FAILURES + 1))
  fi
done

echo "== isolation checks"
for ns in "${ENVS[@]}"; do
  check "$ns reaches its own app via the Service" ALLOWED "$ns" "http://hello.$ns.svc.cluster.local:8080/"
done
check "env-b does NOT reach env-a's app via the Service" BLOCKED env-b "http://hello.env-a.svc.cluster.local:8080/"
check "env-a does NOT reach env-b's app via the Service" BLOCKED env-a "http://hello.env-b.svc.cluster.local:8080/"
for ns in "${ENVS[@]}"; do
  other=$([[ "$ns" == env-a ]] && echo env-b || echo env-a)
  ip=$($K -n "$other" get pod -l app=hello -o jsonpath='{.items[0].status.podIP}')
  check "$ns does NOT reach $other's pod IP" BLOCKED "$ns" "http://$ip:8080/"
done

echo
if [[ $FAILURES -eq 0 ]]; then echo "SPIKE OK: isolation validated."; else echo "SPIKE FAILED: $FAILURES check(s)."; exit 1; fi
