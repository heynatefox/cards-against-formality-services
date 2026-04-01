# Build context: repository root

# ── Stage 1: Build cache-mixin ──────────────────────────────────────────────
FROM node:22.6.0-alpine AS cache-mixin-builder
WORKDIR /home/packages/cache-mixin
COPY packages/cache-mixin .
ENV NODE_ENV=development
RUN yarn install && yarn run build

# ── Stage 2: Build db-mixin ─────────────────────────────────────────────────
FROM node:22.6.0-alpine AS db-mixin-builder
WORKDIR /home/packages/db-mixin
COPY packages/db-mixin .
ENV NODE_ENV=development
RUN yarn install && yarn run build

# ── Stage 3: Build health-check ─────────────────────────────────────────────
FROM node:22.6.0-alpine AS health-check-builder
WORKDIR /home/packages/health-check
COPY packages/health-check .
ENV NODE_ENV=development
RUN yarn install && yarn run build

# ── Stage 4: Build service ───────────────────────────────────────────────────
FROM node:22.6.0-alpine AS builder
WORKDIR /home/packages
COPY --from=cache-mixin-builder  /home/packages/cache-mixin  ./cache-mixin
COPY --from=db-mixin-builder     /home/packages/db-mixin     ./db-mixin
COPY --from=health-check-builder /home/packages/health-check ./health-check
WORKDIR /home/service/games-service
COPY services/games-service .
RUN yarn install --frozen-lockfile
RUN yarn run build

# ── Stage 5: Production image ────────────────────────────────────────────────
FROM node:22.6.0-alpine
ENV NODE_ENV=production
WORKDIR /home/packages
COPY --from=cache-mixin-builder  /home/packages/cache-mixin  ./cache-mixin
COPY --from=db-mixin-builder     /home/packages/db-mixin     ./db-mixin
COPY --from=health-check-builder /home/packages/health-check ./health-check
WORKDIR /home/service/games-service
COPY --from=builder /home/service/games-service/build ./build
COPY services/games-service/package.json services/games-service/yarn.lock ./
RUN yarn install --frozen-lockfile --no-cache --production
CMD node ./build/index.js
