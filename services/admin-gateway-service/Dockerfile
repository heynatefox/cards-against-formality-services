FROM node:12.15.0-alpine AS admin-gateway-service-builder
WORKDIR /home/service/admin-gateway-service
COPY . .
RUN yarn install --frozen-lockfile
RUN yarn run build

FROM node:12.15.0-alpine
WORKDIR /home/service/admin-gateway-service
COPY --from=admin-gateway-service-builder /home/service/admin-gateway-service/build ./build
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --no-cache --production
CMD yarn start