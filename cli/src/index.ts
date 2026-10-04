import { Command } from "commander";
import { ciEnvCreateCommand, ciEnvDestroyCommand } from "./commands/ci-env.js";
import { deployCommand } from "./commands/deploy.js";
import { domainAddCommand, domainListCommand, domainRemoveCommand } from "./commands/domain.js";
import { envListCommand, envSetCommand, envUnsetCommand } from "./commands/env.js";
import { extensionsInstallCommand, extensionsListCommand, extensionsUninstallCommand } from "./commands/extensions.js";
import { importCommand } from "./commands/import.js";
import { initCommand } from "./commands/init.js";
import { loginCommand } from "./commands/login.js";
import { logsCommand } from "./commands/logs.js";
import { rollbackCommand } from "./commands/rollback.js";
import { statusCommand } from "./commands/status.js";
import { templateDeployCommand, templatesListCommand } from "./commands/templates.js";
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

program
  .command("logs")
  .description("Shows deployment logs: a build snapshot by default, or a live tail with --stream")
  .option("--instance <id>", "Service instance ID (overrides the project config)")
  .option("--deployment <id>", "Deployment ID (defaults to the instance's current Running deployment)")
  .option("--stream <stream>", "Tails logs live over SSE: build or runtime")
  .option("--since <timestamp>", "Only with --stream runtime: show logs from this RFC3339 timestamp on")
  .action(
    wrap((opts: { instance?: string; deployment?: string; stream?: string; since?: string }) => logsCommand(opts)),
  );

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

const ciEnv = program.command("ci-env").description("Creates and tears down ephemeral environments for CI jobs");

ciEnv
  .command("create")
  .description("Creates an ephemeral environment, torn down automatically after --ttl seconds")
  .option("--project <id>", "Project ID (overrides the project config)")
  .option("--name <name>", "Environment name (generated if omitted)")
  .option("--ttl <seconds>", "Seconds until automatic teardown (default 600)")
  .action(
    wrap((opts: { project?: string; name?: string; ttl?: string }) => ciEnvCreateCommand(opts)),
  );

ciEnv
  .command("destroy")
  .description("Tears down an ephemeral environment immediately, instead of waiting for its TTL")
  .argument("<environmentId>", "ID of the environment to tear down")
  .option("--project <id>", "Project ID (overrides the project config)")
  .action(wrap((environmentId: string, opts: { project?: string }) => ciEnvDestroyCommand(environmentId, opts)));

const templates = program.command("templates").description("Browses and deploys templates from the marketplace");

templates
  .command("list")
  .description("Lists the templates available in the marketplace")
  .action(wrap(templatesListCommand));

templates
  .command("deploy")
  .description("Deploys a template as a new service in the project")
  .argument("<source>", "Template source, e.g. postgres_template")
  .option("--project <id>", "Project ID (overrides the project config)")
  .option("--name <name>", "Service name (defaults to the template's own name)")
  .action(
    wrap((source: string, opts: { project?: string; name?: string }) => templateDeployCommand(source, opts)),
  );

program
  .command("import")
  .description("Imports services from a Heroku app.json, Render render.yaml or Railway project export")
  .argument("<provider>", "heroku, render or railway")
  .argument("<file>", "Path to the manifest file")
  .option("--project <id>", "Project ID (overrides the project config)")
  .action(wrap((provider: string, file: string, opts: { project?: string }) => importCommand(provider, file, opts)));

const extensions = program.command("extensions").description("Installs and manages extensions (webhook subscriptions with a manifest)");

extensions
  .command("list")
  .description("Lists the organization's installed extensions")
  .option("--organization <id>", "Organization ID (overrides the project config)")
  .action(wrap((opts: { organization?: string }) => extensionsListCommand(opts)));

extensions
  .command("install")
  .description("Installs an extension")
  .argument("<name>", "Extension name")
  .argument("<url>", "Webhook URL the extension receives deliveries at")
  .option("--organization <id>", "Organization ID (overrides the project config)")
  .option("--description <text>", "Extension description (defaults to its name)")
  .option("--secret <secret>", "HMAC signing secret (min 16 characters)")
  .option("--events <events>", "Comma-separated event types, e.g. deployment.status_changed")
  .action(
    wrap(
      (
        name: string,
        url: string,
        opts: { organization?: string; description?: string; secret?: string; events?: string },
      ) => extensionsInstallCommand(name, url, opts),
    ),
  );

extensions
  .command("uninstall")
  .description("Uninstalls an extension")
  .argument("<extensionId>", "ID of the extension to uninstall")
  .option("--organization <id>", "Organization ID (overrides the project config)")
  .action(wrap((extensionId: string, opts: { organization?: string }) => extensionsUninstallCommand(extensionId, opts)));

const domain = program.command("domain").description("Manages the configured service's domains");

domain
  .command("list")
  .description("Lists the instance's domains")
  .option("--instance <id>", "Service instance ID (overrides the project config)")
  .action(wrap((opts: { instance?: string }) => domainListCommand(opts)));

domain
  .command("add")
  .description("Creates a domain for the instance: auto generates the hostname, custom takes --hostname")
  .option("--type <type>", "auto or custom")
  .option("--hostname <hostname>", "Required for --type custom")
  .option("--instance <id>", "Service instance ID (overrides the project config)")
  .action(
    wrap((opts: { instance?: string; type?: string; hostname?: string }) => domainAddCommand(opts)),
  );

domain
  .command("remove")
  .description("Removes a domain from the instance")
  .argument("<domainId>", "ID of the domain to remove")
  .option("--instance <id>", "Service instance ID (overrides the project config)")
  .action(wrap((domainId: string, opts: { instance?: string }) => domainRemoveCommand(domainId, opts)));

await program.parseAsync(process.argv);
