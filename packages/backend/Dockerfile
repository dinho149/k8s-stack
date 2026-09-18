FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json .npmrc ./
COPY packages/backend/package.json packages/backend/package.json
RUN npm ci --ignore-scripts --workspace @stack/backend --include-workspace-root
COPY packages/backend packages/backend
RUN npm run build --workspace @stack/backend
FROM node:22-bookworm-slim
WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/backend ./packages/backend
COPY catalog ./catalog
WORKDIR /workspace/packages/backend
RUN useradd --create-home --uid 10001 stack
USER stack
CMD ["node","dist/index.js","--config","/config/app-config.yaml"]
