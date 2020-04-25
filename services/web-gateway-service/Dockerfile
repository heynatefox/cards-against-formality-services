FROM node:12.15.0-alpine AS web-gateway-service-builder
WORKDIR /home/service/web-gateway-service
COPY . .
RUN yarn install --frozen-lockfile
RUN yarn run build

FROM node:12.15.0-alpine
ENV NODE_ENV=production
WORKDIR /home/service/web-gateway-service
COPY --from=web-gateway-service-builder /home/service/web-gateway-service/build ./build
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --no-cache --production
CMD yarn start