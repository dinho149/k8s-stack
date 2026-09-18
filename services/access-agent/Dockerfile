# access-agent: Claude + MCP chat gateway (Slack / Teams / Google Chat / CLI)
#
# Build context: services/access-agent. The npm lockfile lives at the repo root (npm workspaces), so the
# build ALSO receives the repo root as a named context called `lockfile`:
#   docker build --build-context lockfile=<repo-root> -t k8s-teleport/access-agent services/access-agent   (Dogfood repo root)
# (deploy/teleport/scripts/load-images.sh and the GitHub workflows pass it). `npm ci` then validates the real
# lockfile against a minimal workspace skeleton, so dependency drift fails the build instead of being
# silently resolved.
#
# Bases: Chainguard node (glibc, non-root `node` = 65532, no apt/apk/git/shell in the runtime image),
# pinned by digest; Dependabot refreshes them. Refresh manually:
#   docker buildx imagetools inspect cgr.dev/chainguard/node:latest-dev
ARG CLAUDE_CODE_VERSION=2.1.274

FROM cgr.dev/chainguard/node:latest-dev@sha256:2a2df3a1f79cfe63317e3e6e2b7394cac434648fdfc82e4f702d0e6dc4d9a852 AS build
ARG CLAUDE_CODE_VERSION
# root only in this build stage (nothing from it runs in the final image): /opt/claude, /home/app and
# /var/lib/access-agent are created here and copied with --chown.
# hadolint ignore=DL3002,DL3066
USER root
WORKDIR /work
# Workspace skeleton: root manifest + lockfile + every workspace's package.json, so `npm ci` can validate.
# `lockfile` is a named build context (docker build --build-context lockfile=<repo-root>), not a stage.
# hadolint ignore=DL3022
COPY --from=lockfile package.json package-lock.json ./
# hadolint ignore=DL3022
COPY --from=lockfile infra/teleport/package.json ./infra/teleport/
# hadolint ignore=DL3022
COPY --from=lockfile services/agent/package.json ./services/agent/
# hadolint ignore=DL3022
COPY --from=lockfile packages/backend/package.json ./packages/backend/
# hadolint ignore=DL3022
COPY --from=lockfile packages/portal/package.json ./packages/portal/
COPY package.json ./services/access-agent/
RUN npm ci --workspace=services/access-agent --include-workspace-root=false --no-fund --no-audit
COPY tsconfig.json tsconfig.build.json ./services/access-agent/
COPY src ./services/access-agent/src
RUN npm run build --workspace=services/access-agent \
 && rm -rf node_modules services/access-agent/node_modules \
 && npm ci --workspace=services/access-agent --include-workspace-root=false --omit=dev --no-fund --no-audit \
 && mkdir -p services/access-agent/node_modules
# Claude Code CLI for the subscription backend, installed into its own prefix and copied as a whole.
# npm >= 11.15 skips install scripts for global installs, so the postinstall that swaps the
# bin/claude.exe placeholder for the platform-native binary is run explicitly, then verified.
RUN npm install -g --prefix /opt/claude --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && node /opt/claude/lib/node_modules/@anthropic-ai/claude-code/install.cjs \
 && /opt/claude/bin/claude --version \
 && mkdir -p /var/lib/access-agent/claude /home/app \
 && chown -R 65532:65532 /var/lib/access-agent /opt/claude /home/app

FROM cgr.dev/chainguard/node:latest@sha256:1f903d44fc11a6f6e74447fc2c6a3c141f112217576be5d96c283210116b5d25
# uid 65532 = `node` in the Chainguard image; the Deployment sets runAsUser: 65532 and HOME=/home/app.
ENV NODE_ENV=production \
    HOME=/home/app \
    CLAUDE_STATE_DIR=/var/lib/access-agent/claude \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    PATH=/opt/claude/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /app/services/access-agent
COPY --from=build --chown=65532:65532 /opt/claude /opt/claude
COPY --from=build --chown=65532:65532 /var/lib/access-agent /var/lib/access-agent
COPY --from=build --chown=65532:65532 /home/app /home/app
COPY --from=build /work/package.json /work/package-lock.json /app/
COPY --from=build /work/node_modules /app/node_modules
COPY --from=build /work/services/access-agent/node_modules ./node_modules
COPY --from=build /work/services/access-agent/dist ./dist
COPY package.json ./
USER 65532:65532
EXPOSE 8082
# No curl/wget in the image: probe /healthz with node itself.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8082)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
