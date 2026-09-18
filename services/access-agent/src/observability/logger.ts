import pino from "pino";

export type Logger = pino.Logger;

/** Anything that could carry a credential is censored wherever it appears in a log object. */
export const REDACT_PATHS = [
  "*.token",
  "*.*.token",
  "*.password",
  "*.secret",
  "*.MCP_SHARED_TOKEN",
  "*.BROKER_API_TOKEN",
  "*.BROKER_WEBHOOK_SECRET",
  "*.IDENTITY_SIGNING_KEY",
  "*.CLAUDE_CODE_OAUTH_TOKEN",
  "*.ANTHROPIC_API_KEY",
  "*.SLACK_BOT_TOKEN",
  "*.SLACK_APP_TOKEN",
  "*.TEAMS_APP_PASSWORD",
  "*.GCHAT_SERVICE_ACCOUNT_JSON",
  "*.headers.authorization",
  '*.headers["x-teleport-assertion"]',
  "req.headers.authorization",
  'req.headers["x-teleport-assertion"]',
];

export function createLogger(level = "info", pretty = false): Logger {
  return pino({
    level,
    base: { service: "access-agent" },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } } : {}),
  });
}
