FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json .npmrc ./
COPY packages/portal/package.json packages/portal/package.json
RUN npm ci --ignore-scripts --workspace @dogfood/portal --include-workspace-root
COPY packages/portal packages/portal
ARG VITE_BACKEND_URL
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_LOCAL_DEVELOPMENT=false
RUN npm run build --workspace @dogfood/portal
FROM nginxinc/nginx-unprivileged:1.31.6-alpine
COPY packages/portal/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/packages/portal/dist /usr/share/nginx/html
