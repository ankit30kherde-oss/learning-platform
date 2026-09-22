# ---------------------------------------------------------------------------
# api-gateway - same shape as the services, minus Prisma (it owns no data).
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api-gateway/package.json apps/api-gateway/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile=false --filter api-gateway... --prod=false

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api-gateway apps/api-gateway
RUN pnpm --filter @lp/shared build \
 && pnpm --filter api-gateway build \
 && pnpm deploy --filter api-gateway --prod /app

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:${GATEWAY_PORT:-4000}/healthz || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
