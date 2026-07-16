FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS build
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

FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS runtime
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
