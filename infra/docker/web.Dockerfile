FROM node:26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS build
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --filter @akep/web... --frozen-lockfile

COPY apps/web apps/web
RUN pnpm --filter @akep/web build

FROM nginx:1.30.4-alpine@sha256:59d10bca5c674965ef4ff884715000dd60ef5567c36663523f108eec8e4105d4
COPY infra/docker/web.nginx.conf /etc/nginx/nginx.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
