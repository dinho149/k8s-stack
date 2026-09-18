/**
 * access-agent entrypoint (in-cluster): chat adapters + HTTP server.
 */
import { loadConfig, csv } from "./config/schema.js";
import { createLogger } from "./observability/logger.js";
import { buildApp } from "./app.js";
import { buildServer } from "./http/server.js";
import type { ChatAdapter } from "./adapters/types.js";
import { SlackAdapter } from "./adapters/slack/index.js";
import { TeamsAdapter } from "./adapters/teams/index.js";
import { GoogleChatAdapter } from "./adapters/gchat/index.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL, cfg.LOG_PRETTY);
  const adapters: ChatAdapter[] = [];
  for (const name of csv(cfg.ADAPTERS)) {
    if (name === "slack") adapters.push(new SlackAdapter(cfg, log));
    else if (name === "teams") adapters.push(new TeamsAdapter(cfg, log));
    else if (name === "gchat") adapters.push(new GoogleChatAdapter(cfg, log));
    else if (name === "cli") log.warn("cli adapter is only available through `npm run cli`; ignoring");
    else throw new Error(`unknown adapter ${name}`);
  }
  const app = buildApp(cfg, log, adapters);
  const deps = { log, adapters, webhook: app.webhook, onBrokerEvent: (ev: Parameters<typeof app.notifications.handleEvent>[0]) => app.notifications.handleEvent(ev), ready: app.ready };
  // With PUBLIC_PORT the chat webhooks get their own listener; the broker webhook and readiness stay internal.
  const internal = buildServer(deps, cfg.PUBLIC_PORT === undefined ? "all" : "internal");
  const pub = cfg.PUBLIC_PORT === undefined ? null : buildServer(deps, "public");
  const servers = [internal, ...(pub ? [pub] : [])];
  await internal.listen({ port: cfg.PORT, host: "0.0.0.0" });
  if (pub) await pub.listen({ port: cfg.PUBLIC_PORT, host: "0.0.0.0" });
  for (const a of adapters) await a.start();
  log.info({ port: cfg.PORT, publicPort: cfg.PUBLIC_PORT ?? null, adapters: adapters.map((a) => a.name), model: cfg.CLAUDE_MODEL, backend: app.backend.name }, "access-agent started");
  void app.backend.probe().then((p) => log[p.ok ? "info" : "error"]({ backend: app.backend.name, ...p }, "claude credential probe"));
  const shutdown = async () => {
    log.info("shutting down");
    await app.stop();
    await Promise.all(servers.map((s) => s.close()));
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
