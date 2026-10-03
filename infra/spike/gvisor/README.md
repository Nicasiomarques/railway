# Spike: sandbox do build com gVisor

Objetivo: validar se o build pode rodar num kernel de usuário (gVisor) em vez do kernel do nó, e se isso dispensa as concessões do BuildKit rootless.

Instalação: `./install.sh` (checksums conferidos, RuntimeClass `gvisor`). Verificação do sandbox: um pod com `runtimeClassName: gvisor` reporta kernel `4.4.0` (versão fixa do gVisor), contra o kernel real do host.

## Resultados medidos

| Pergunta | Resultado |
|---|---|
| Pod roda sob gVisor no k3d? | Sim. Kernel reportado 4.4.0 (gVisor) |
| A política de egress vale sob gVisor? | Sim. API do cluster dá `rc=7`, host liberado `200`, internet `200` (idêntico ao runc) |
| DNS do cluster sob gVisor? | Funciona para `kubernetes.default.svc`. `host.k3d.internal` **não resolve** (detalhe do k3d, não do gVisor) |
| Build com `RUN npm install` sob gVisor, sandbox de processo ligado, snapshotter nativo | **Sim** (app Node sem Dockerfile, publicado e puxado pelo digest) |
| Snapshotter overlay (padrão rootless) sob gVisor | **Não**: `mount callback failed … transport endpoint is not connected` (FUSE) |
| BuildKit rootless sem seccomp `Unconfined` e sem escalada de privilégio | **Não**: `newuidmap` precisa de setuid, bloqueado sem escalada |
| BuildKit root, seccomp `RuntimeDefault`, sem escalada, com `SYS_ADMIN` (+ `SYS_PTRACE`, `NET_ADMIN` etc.) | **Não no `RUN`**: clone, detect e pull passam; `runc` falha com `setns: operation not permitted` ao entrar no mount namespace do container. Não melhora com `--oci-worker-no-process-sandbox` |

## O que isso significa

- O gVisor adiciona a barreira de kernel: um escape do build cai no sandbox, não no kernel do nó.
- As concessões de seccomp `Unconfined` e escalada de privilégio **continuam** para o BuildKit rootless. O gVisor não as elimina sozinho.
- Padrão de produção atual: `runtimeClass: gvisor`, `--oci-worker-snapshotter=native`, sandbox de processo ligado.

## Conclusão da investigação de root

Nenhuma combinação testada dispensa as concessões do BuildKit rootless sob gVisor. O gVisor não implementa o `setns` para mount namespace que o `runc` usa no modo root. A única saída que isola de verdade sem essas concessões é outro modelo de isolamento: microVM (Kata/Firecracker), que exige `/dev/kvm` no nó. O k3d no Docker Desktop não expõe KVM, então isso só é testável em um nó Linux dedicado.

## Pendente

- Medir o custo do snapshotter nativo (cópia de camadas) em builds grandes.
- Política de egress com DNS real (hoje o build precisa de IP para o host de teste).
