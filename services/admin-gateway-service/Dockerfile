ARG CACHE_MIXIN
ARG HEALTH_CHECK

FROM $CACHE_MIXIN AS cache-mixin
FROM $HEALTH_CHECK AS health-check

FROM scratch AS deps
COPY --link --from=cache-mixin / /
COPY --link --from=health-check / /

FROM node:22.6.0-alpine AS admin-gateway-service-builder
WORKDIR /home/packages
COPY --link --from=deps / .
WORKDIR /home/service/admin-gateway-service
COPY . .
RUN yarn install --frozen-lockfile
RUN yarn run build

FROM node:22.6.0-alpine
ENV NODE_ENV=production
WORKDIR /home/packages
COPY --link --from=deps / .
WORKDIR /home/service/admin-gateway-service
COPY --from=admin-gateway-service-builder /home/service/admin-gateway-service/build ./build
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --no-cache --production
CMD node ./build/index.js