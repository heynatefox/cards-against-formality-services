FROM node:22.6.0-alpine AS builder
WORKDIR /home/packages/db-mixin
COPY . .
ENV NODE_ENV=development
RUN yarn
RUN yarn run build

FROM scratch

WORKDIR /db-mixin
COPY --link --from=builder /home/packages/db-mixin/package.json .
COPY --link --from=builder /home/packages/db-mixin/yarn.lock .
COPY --link --from=builder /home/packages/db-mixin/build ./build
COPY --link --from=builder /home/packages/db-mixin/node_modules ./node_modules
