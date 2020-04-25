FROM node:12.15.0-alpine AS clients-service-builder
WORKDIR /home/service/clients-service
COPY . ./
RUN yarn install --frozen-lockfile
RUN yarn run build

FROM node:12.15.0-alpine
ENV NODE_ENV=production
WORKDIR /home/service/clients-service
COPY --from=clients-service-builder /home/service/clients-service/build ./build
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --no-cache --production
CMD yarn start