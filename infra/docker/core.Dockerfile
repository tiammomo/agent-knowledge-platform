FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/core/package.json apps/core/package.json
RUN pnpm install --filter @akep/core... --frozen-lockfile

COPY apps/core apps/core
COPY infra/postgres/migrations infra/postgres/migrations
COPY specs specs
RUN pnpm --filter @akep/core build
# Core has no workspace runtime dependencies. Legacy deploy keeps the repository's
# normal workspace linking mode unchanged while producing a production-only tree.
RUN pnpm --filter @akep/core deploy --legacy --prod /opt/akep-core

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
ENV NODE_ENV=production
WORKDIR /opt/akep-core
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=build --chown=node:node /opt/akep-core ./
COPY --from=build --chown=node:node /workspace/infra/postgres/migrations ./infra/postgres/migrations
COPY --from=build --chown=node:node /workspace/specs ./specs

USER node
EXPOSE 3000
CMD ["node", "dist/entrypoint.js"]
