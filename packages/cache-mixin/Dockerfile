FROM node:22.6.0-alpine AS builder
WORKDIR /home/packages/cache-mixin
COPY . .
ENV NODE_ENV=development
RUN yarn
RUN yarn run build

FROM scratch

WORKDIR /cache-mixin
COPY --link --from=builder /home/packages/cache-mixin/package.json .
COPY --link --from=builder /home/packages/cache-mixin/yarn.lock .
COPY --link --from=builder /home/packages/cache-mixin/build ./build
COPY --link --from=builder /home/packages/cache-mixin/node_modules ./node_modules
