FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json .npmrc ./
COPY services/agent/package.json services/agent/package.json
RUN npm ci --workspace @stack/agent --include-workspace-root
COPY services/agent services/agent
RUN npm run build --workspace @stack/agent
FROM node:22-bookworm-slim
WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/services/agent ./services/agent
RUN mkdir /state && chown -R 10001:10001 /state /workspace
ENV AGENT_STATE_DIR=/state
RUN useradd --create-home --uid 10001 stack
USER stack
CMD ["node", "services/agent/dist/server.js"]
