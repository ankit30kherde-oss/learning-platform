# ---------------------------------------------------------------------------
# course-service
#
# Multi-stage: the build stage carries pnpm, the compiler and every devDependency;
# the runtime stage carries none of them. That is worth roughly 400 MB and, more
# importantly, removes the toolchain an attacker would use after a compromise.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

# --- dependencies ----------------------------------------------------------
FROM base AS deps
# Copy only the manifests first so a code change does not bust the install cache.
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/course-service/package.json apps/course-service/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile=false --filter course-service... --prod=false

# --- build -----------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/course-service apps/course-service
RUN pnpm --filter @lp/shared build \
 && pnpm --filter course-service exec prisma generate --schema=prisma/schema.prisma \
 && pnpm --filter course-service build \
 && pnpm deploy --filter course-service --prod /app

# --- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# dumb-init reaps zombies and forwards signals, so SIGTERM from Kubernetes
# actually reaches Node and the pod drains instead of being killed at 30s.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init ca-certificates curl openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=node:node /app ./
COPY --from=build --chown=node:node /repo/apps/course-service/prisma ./prisma

USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:${PORT:-4000}/healthz || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
