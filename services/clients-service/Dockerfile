ARG CACHE_MIXIN
ARG DB_MIXIN
ARG HEALTH_CHECK

FROM $CACHE_MIXIN AS cache-mixin
FROM $DB_MIXIN AS db-mixin
FROM $HEALTH_CHECK AS health-check

FROM scratch AS deps
COPY --link --from=cache-mixin / /
COPY --link --from=db-mixin / /
COPY --link --from=health-check / /

FROM node:22.6.0-alpine AS clients-service-builder
WORKDIR /home/packages
COPY --link --from=deps / .
WORKDIR /home/service/clients-service
COPY . ./
RUN yarn install --frozen-lockfile
RUN yarn run build

FROM node:22.6.0-alpine
ENV NODE_ENV=production
WORKDIR /home/packages
COPY --link --from=deps / .
WORKDIR /home/service/clients-service
COPY --from=clients-service-builder /home/service/clients-service/build ./build
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --no-cache --production
CMD yarn start
