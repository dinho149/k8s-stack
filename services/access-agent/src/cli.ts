/**
 * Terminal REPL: `npm run cli -- --as alice [--email alice@example.com] [--script file]`
 * Talks to the real MCP server and broker (port-forwarded locally) and also receives broker webhooks
 * on PORT so approval cards show up in the terminal.
 *
 * Needs MCP_SHARED_TOKEN and IDENTITY_SIGNING_KEY (same values the cluster uses): every MCP and broker
 * call carries a signed assertion for `--as <user>` with platform "cli".
 */
import * as fs from "node:fs";
import { loadConfig } from "./config/schema.js";
import { createLogger } from "./observability/logger.js";
import { buildApp } from "./app.js";
import { buildServer } from "./http/server.js";
import { CliAdapter } from "./adapters/cli/index.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  // Default to the operator's own Claude subscription login when the claude CLI is available and no API key
  // is exported; AUTH=api-key (or CLAUDE_AUTH_MODE) overrides.
  const mode = process.env.CLAUDE_AUTH_MODE ?? (process.env.ANTHROPIC_API_KEY ? "api-key" : "subscription");
  const cfg = loadConfig({
    ...process.env,
    CLAUDE_AUTH_MODE: mode,
    CLAUDE_ALLOW_LOCAL_LOGIN: process.env.CLAUDE_ALLOW_LOCAL_LOGIN ?? (mode === "subscription" && !process.env.CLAUDE_CODE_OAUTH_TOKEN ? "true" : "false"),
    CLAUDE_STATE_DIR: process.env.CLAUDE_STATE_DIR ?? `${process.env.HOME}/.cache/k8s-teleport/claude`,
    MCP_URL: process.env.MCP_URL ?? "http://localhost:8080/mcp",
    BROKER_URL: process.env.BROKER_URL ?? "http://localhost:8081",
    ADAPTERS: "cli",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
  });
  const log = createLogger(cfg.LOG_LEVEL, true);
  const as = arg("--as") ?? process.env.TELEPORT_USER ?? "admin";
  const email = arg("--email") ?? (as.includes("@") ? as : `${as}@example.com`);
  const scriptFile = arg("--script");
  const cli = new CliAdapter({ teleportUser: as.includes("@") ? as.split("@")[0] : as, email, script: scriptFile ? fs.readFileSync(scriptFile, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")) : undefined });
  const app = buildApp(cfg, log, [cli]);
  process.stderr.write(`backend: ${app.backend.name}${app.backend.name === "subscription" ? (cfg.CLAUDE_CODE_OAUTH_TOKEN ? " (setup-token)" : " (your local claude login)") : ""}  model: ${cfg.CLAUDE_MODEL}\n`);
  const server = buildServer({ log, adapters: [cli], webhook: app.webhook, onBrokerEvent: (ev) => app.notifications.handleEvent(ev), ready: app.ready });
  await server.listen({ port: cfg.PORT, host: "127.0.0.1" }).catch(() => log.warn("webhook port busy; approval cards will not stream in"));
  await cli.start();
  await cli.done;
  await app.stop();
  await server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
