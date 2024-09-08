FROM node:22.6.0-alpine AS builder
WORKDIR /home/packages/health-check
COPY . .
ENV NODE_ENV=development
RUN yarn
RUN yarn run build

FROM scratch

WORKDIR /health-check
COPY --link --from=builder /home/packages/health-check/package.json .
COPY --link --from=builder /home/packages/health-check/yarn.lock .
COPY --link --from=builder /home/packages/health-check/build ./build
COPY --link --from=builder /home/packages/health-check/node_modules ./node_modules
