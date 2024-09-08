ARG CACHE_MIXIN
ARG HEALTH_CHECK

FROM $CACHE_MIXIN AS cache-mixin
FROM $HEALTH_CHECK AS health-check

FROM scratch AS deps
COPY --link --from=cache-mixin / /
COPY --link --from=health-check / /

FROM node:22.6.0-alpine
WORKDIR /home/packages
COPY --link --from=deps / .
WORKDIR /home/service/web-gateway-service
COPY . .
ENV NODE_ENV=development
RUN yarn
CMD yarn run dev
