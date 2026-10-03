import { Command } from "commander";
import { deployCommand } from "./commands/deploy.js";
import { envListCommand, envSetCommand, envUnsetCommand } from "./commands/env.js";
import { initCommand } from "./commands/init.js";
import { loginCommand } from "./commands/login.js";
import { rollbackCommand } from "./commands/rollback.js";
import { statusCommand } from "./commands/status.js";
import { formatError } from "./http.js";

// Envolve cada action: erros (ApiProblem ou outros) saem como mensagem legível, nunca JSON bruto ou stack trace.
function wrap<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(formatError(err));
      process.exitCode = 1;
    }
  };
}

const program = new Command();

program.name("railway-like").description("CLI da plataforma").version("0.0.0");

program
  .command("login")
  .description("Autentica: pede a URL da API e o token, valida e grava em ~/.railway-like/config.json")
  .action(wrap(loginCommand));

program
  .command("init")
  .description("Configura o diretório atual com organização, projeto, ambiente e serviço escolhidos")
  .action(wrap(initCommand));

program
  .command("deploy")
  .description("Redeploy do serviço configurado (mesma imagem/commit do último deployment)")
  .option("--instance <id>", "ID da instância de serviço (sobrepõe o config do projeto)")
  .action(wrap((opts: { instance?: string }) => deployCommand(opts)));

program
  .command("status")
  .description("Lista os deployments recentes e o estado atual da instância")
  .option("--instance <id>", "ID da instância de serviço (sobrepõe o config do projeto)")
  .action(wrap((opts: { instance?: string }) => statusCommand(opts)));

program
  .command("rollback")
  .description("Reverte para um deployment anterior")
  .argument("<deploymentId>", "ID do deployment para o qual reverter")
  .action(wrap((deploymentId: string) => rollbackCommand(deploymentId)));

// TODO: logs — rota ainda não existe (ver docs/architecture.md §9; GET /v1/deployments/{id}/logs
// hoje só devolve o último retrato do build, sem tail em tempo real).
// TODO: domain — rota ainda não existe.

const env = program.command("env").description("Gerencia variáveis de ambiente do serviço configurado");

env
  .command("list")
  .description("Lista as variáveis da instância (secrets aparecem mascarados)")
  .option("--instance <id>", "ID da instância de serviço (sobrepõe o config do projeto)")
  .action(wrap((opts: { instance?: string }) => envListCommand(opts)));

env
  .command("set")
  .description("Cria ou atualiza uma variável")
  .argument("<assignment>", "no formato KEY=VALUE")
  .option("--secret", "marca a variável como secreta")
  .option("--instance <id>", "ID da instância de serviço (sobrepõe o config do projeto)")
  .action(wrap((assignment: string, opts: { instance?: string; secret?: boolean }) => envSetCommand(assignment, opts)));

env
  .command("unset")
  .description("Remove uma variável")
  .argument("<key>")
  .option("--instance <id>", "ID da instância de serviço (sobrepõe o config do projeto)")
  .action(wrap((key: string, opts: { instance?: string }) => envUnsetCommand(key, opts)));

await program.parseAsync(process.argv);
