FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --filter @akep/web... --frozen-lockfile

COPY apps/web apps/web
RUN pnpm --filter @akep/web build

FROM nginx:1.31.3-alpine@sha256:2776cd5b70d8983e27e9f5c90abee3d24c690014ae8ecbb529572d954a459096
COPY infra/docker/web.nginx.conf /etc/nginx/nginx.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
