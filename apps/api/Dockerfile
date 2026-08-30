# syntax=docker/dockerfile:1.7
# Multi-stage build for @glps/api. Build context is the MONOREPO ROOT
# (docker-compose.yml sets `context: .`), because the api depends on the
# workspace packages (@glps/core, @glps/contracts, @glps/item-data).

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

# ---- deps: full workspace install (dev deps included) for building ----
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/item-data/package.json packages/item-data/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile

# ---- build: compile the pure/impure TS packages the api needs ----
FROM deps AS build
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @glps/core --filter @glps/contracts --filter @glps/item-data --filter @glps/api run build

# ---- prod-deps: production-only install, same lockfile ----
FROM base AS prod-deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/item-data/package.json packages/item-data/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --prod

# ---- runner: no network access at runtime (§5); catalogs ship in the image ----
FROM node:22-alpine AS runner
RUN addgroup -S glps && adduser -S glps -G glps -H
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/packages/core/node_modules ./packages/core/node_modules
COPY --from=prod-deps /repo/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=prod-deps /repo/packages/item-data/node_modules ./packages/item-data/node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./apps/api/node_modules

COPY --from=build /repo/packages/core/dist ./packages/core/dist
COPY --from=build /repo/packages/core/package.json ./packages/core/package.json
COPY --from=build /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /repo/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /repo/packages/item-data/dist ./packages/item-data/dist
COPY --from=build /repo/packages/item-data/package.json ./packages/item-data/package.json
COPY packages/item-data/classic-era ./packages/item-data/classic-era
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY apps/api/src/db/migrations ./apps/api/dist/db/migrations

# Workspace package.jsons point "main"/"exports" at ./src/index.ts for fast
# TS-native dev (tsx/vitest resolve it directly) — the runner image has no
# .ts files, only compiled dist/, so repoint them here to the built output.
RUN for pkg in core contracts item-data; do \
      node -e "const fs=require('fs'); const p='./packages/$pkg/package.json'; const j=JSON.parse(fs.readFileSync(p)); j.main='./dist/index.js'; j.types='./dist/index.d.ts'; j.exports={'.': {types:'./dist/index.d.ts', default:'./dist/index.js'}}; fs.writeFileSync(p, JSON.stringify(j, null, 2));"; \
    done

RUN chown -R glps:glps /repo
USER glps
WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["node", "dist/server.js"]
