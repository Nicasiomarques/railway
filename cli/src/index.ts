import { Command } from "commander";
import { deployCommand } from "./commands/deploy.js";
import { envListCommand, envSetCommand, envUnsetCommand } from "./commands/env.js";
import { initCommand } from "./commands/init.js";
import { loginCommand } from "./commands/login.js";
import { rollbackCommand } from "./commands/rollback.js";
import { statusCommand } from "./commands/status.js";
import { formatError } from "./http.js";

// Wraps each action: errors (ApiProblem or otherwise) come out as a readable message, never raw JSON or a stack trace.
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

program.name("railway-like").description("Platform CLI").version("0.0.0");

program
  .command("login")
  .description("Authenticate: asks for the API URL and token, validates them and saves to ~/.railway-like/config.json")
  .action(wrap(loginCommand));

program
  .command("init")
  .description("Configures the current directory with the chosen organization, project, environment and service")
  .action(wrap(initCommand));

program
  .command("deploy")
  .description("Redeploys the configured service (same image/commit as the last deployment)")
  .option("--instance <id>", "Service instance ID (overrides the project config)")
  .action(wrap((opts: { instance?: string }) => deployCommand(opts)));

program
  .command("status")
  .description("Lists recent deployments and the instance's current state")
  .option("--instance <id>", "Service instance ID (overrides the project config)")
  .action(wrap((opts: { instance?: string }) => statusCommand(opts)));

program
  .command("rollback")
  .description("Rolls back to a previous deployment")
  .argument("<deploymentId>", "ID of the deployment to roll back to")
  .action(wrap((deploymentId: string) => rollbackCommand(deploymentId)));

// TODO: logs — GET /v1/deployments/{id}/logs now supports ?stream=build|runtime (SSE), but no CLI
// command wraps it yet.
// TODO: domain — the route doesn't exist yet.

const env = program.command("env").description("Manages the configured service's environment variables");

env
  .command("list")
  .description("Lists the instance's variables (secrets appear masked)")
  .option("--instance <id>", "Service instance ID (overrides the project config)")
  .action(wrap((opts: { instance?: string }) => envListCommand(opts)));

env
  .command("set")
  .description("Creates or updates a variable")
  .argument("<assignment>", "in KEY=VALUE format")
  .option("--secret", "marks the variable as secret")
  .option("--instance <id>", "Service instance ID (overrides the project config)")
  .action(wrap((assignment: string, opts: { instance?: string; secret?: boolean }) => envSetCommand(assignment, opts)));

env
  .command("unset")
  .description("Removes a variable")
  .argument("<key>")
  .option("--instance <id>", "Service instance ID (overrides the project config)")
  .action(wrap((key: string, opts: { instance?: string }) => envUnsetCommand(key, opts)));

await program.parseAsync(process.argv);
