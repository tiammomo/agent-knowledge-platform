FROM node:24.16.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/core/package.json apps/core/package.json
RUN pnpm install --filter @akep/core... --frozen-lockfile

COPY apps/core apps/core
COPY infra/postgres/migrations infra/postgres/migrations
COPY specs specs
RUN pnpm --filter @akep/core build

FROM node:24.16.0-bookworm-slim AS runtime
ENV NODE_ENV=development
WORKDIR /workspace
RUN corepack enable

COPY --from=build /workspace/package.json /workspace/pnpm-workspace.yaml /workspace/pnpm-lock.yaml ./
COPY --from=build /workspace/node_modules node_modules
COPY --from=build /workspace/apps/core/package.json apps/core/package.json
COPY --from=build /workspace/apps/core/node_modules apps/core/node_modules
COPY --from=build /workspace/apps/core/dist apps/core/dist
COPY --from=build /workspace/infra/postgres/migrations infra/postgres/migrations
COPY --from=build /workspace/specs specs

USER node
EXPOSE 3000
CMD ["node", "apps/core/dist/entrypoint.js"]
