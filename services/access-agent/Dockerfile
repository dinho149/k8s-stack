# access-agent: Claude + MCP chat gateway (Slack / Teams / Google Chat / CLI)
# glibc base: the subscription backend runs the Claude Code CLI, whose native helpers need glibc.
ARG CLAUDE_CODE_VERSION=2.1.274
FROM node:25-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-fund --no-audit
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:25-bookworm-slim
ARG CLAUDE_CODE_VERSION
ENV NODE_ENV=production \
    CLAUDE_STATE_DIR=/var/lib/access-agent/claude \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-fund --no-audit @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && groupadd -r app && useradd -r -g app -m -d /home/app app \
 && mkdir -p /var/lib/access-agent/claude && chown -R app:app /var/lib/access-agent
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER app
EXPOSE 8082
CMD ["node", "dist/index.js"]
