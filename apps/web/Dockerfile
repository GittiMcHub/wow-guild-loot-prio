# syntax=docker/dockerfile:1.7
# Build context is the MONOREPO ROOT (see docker-compose.yml).

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=${VITE_API_BASE}
COPY apps/web apps/web
RUN pnpm --filter @glps/web run build

FROM nginx:1.27-alpine AS runner
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
