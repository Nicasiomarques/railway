# k3s spike: isolation between environments

Validates `architecture.md` §7.2 (one namespace per environment, default-deny NetworkPolicy, restricted
profile) with a real app. Runs on a local cluster created with k3d:

```bash
k3d cluster create railway-dev --agents 1 --wait
./run.sh
```

## Result

All checks pass (`SPIKE OK`), and the result holds across runs.

- Traffic within the environment: HTTP 200, both via the Service and the pod's IP.
- Traffic between environments: blocked (HTTP 000), both via the Service and the pod's IP.

## Findings that change the design

1. **A race in policy programming.** kube-router takes a few seconds to program a newly created
   pod's IP. An ephemeral client that `curl`s immediately gets a false block. The script waits for
   the environment's own positive result before evaluating any negative one. For the deploy
   controller: after creating a workload, the health check needs tolerance for this delay.
2. **The selector wasn't the cause.** At first, `podSelector: {}` seemed to not allow traffic
   within the environment. It was the race from item 1: the test was blocking before the policy
   was programmed. The script uses an explicit `namespaceSelector` to keep the intent readable, but
   `podSelector` also works.
3. **Pod Security `restricted` rejects helper pods without a full securityContext.** Any
   diagnostic pod in the namespace needs `runAsNonRoot`, seccomp `RuntimeDefault` and
   `capabilities.drop: [ALL]`.
4. **Images with an entrypoint.** `curlimages/curl` has `curl` as its entrypoint. To run `sh -c`,
   `command` needs to be set explicitly in the manifest.

## What this spike doesn't cover

- **Cloud metadata (`169.254.169.254`).** The block is in the policy, but k3d doesn't have that
  endpoint, so the test can't run here.
- **Build isolation** (rootless BuildKit, microVM, restricted egress). That's a different spike.
- **Edge and ingress** to expose the app. Falls under the domain/TLS item.
