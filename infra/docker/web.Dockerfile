FROM node:24.16.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --filter @akep/web... --frozen-lockfile

COPY apps/web apps/web
RUN pnpm --filter @akep/web build

FROM nginx:1.28.0-alpine
COPY infra/docker/web.nginx.conf /etc/nginx/nginx.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
