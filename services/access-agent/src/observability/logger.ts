import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level = "info", pretty = false): Logger {
  return pino({
    level,
    base: { service: "access-agent" },
    redact: { paths: ["*.token", "*.password", "*.secret", "req.headers.authorization"], censor: "[redacted]" },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } } : {}),
  });
}
