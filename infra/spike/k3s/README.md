# Spike k3s: isolamento entre ambientes

Valida `architecture.md` §7.2 (namespace por ambiente, NetworkPolicy default-deny, perfil restricted)
com um app real. Roda em um cluster local criado com k3d:

```bash
k3d cluster create railway-dev --agents 1 --wait
./run.sh
```

## Resultado

Todas as verificações passam (`SPIKE OK`), e o resultado se repete entre execuções.

- Tráfego dentro do ambiente: HTTP 200, pelo Service e pelo IP do pod.
- Tráfego entre ambientes: bloqueado (HTTP 000), pelo Service e pelo IP do pod.

## Achados que mudam o desenho

1. **Corrida na programação da política.** O kube-router leva alguns segundos para programar o IP
   de um pod recém-criado. Um cliente efêmero que faz `curl` imediatamente recebe bloqueio falso.
   O script espera o positivo do próprio ambiente antes de avaliar qualquer negativo. Para o
   controlador de deploy: após criar um workload, o health check precisa ter tolerância a esse atraso.
2. **O seletor não era a causa.** Num primeiro momento, `podSelector: {}` pareceu não liberar o tráfego
   dentro do ambiente. Era a corrida do item 1: o teste bloqueava antes de a política ser programada.
   O script usa `namespaceSelector` explícito para deixar a intenção legível, mas o `podSelector` também funciona.
3. **Pod Security `restricted` rejeita pods auxiliares sem securityContext completo.** Qualquer
   pod de diagnóstico no namespace precisa de `runAsNonRoot`, seccomp `RuntimeDefault` e
   `capabilities.drop: [ALL]`.
4. **Imagens com entrypoint.** `curlimages/curl` tem `curl` como entrypoint. Para rodar `sh -c`,
   é preciso definir `command` explicitamente no manifesto.

## O que este spike não cobre

- **Metadados de nuvem (`169.254.169.254`).** O bloqueio está na política, mas k3d não tem esse
  endpoint, então o teste não é executável aqui.
- **Isolamento de build** (BuildKit rootless, microVM, egress restrito). É outro spike.
- **Edge e ingress** para expor o app. Entra no item de domínio/TLS.
