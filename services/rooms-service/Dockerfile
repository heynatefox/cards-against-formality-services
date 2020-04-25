FROM node:12.15.0-alpine AS rooms-service-builder
WORKDIR /home/service/rooms-service
COPY . ./
RUN yarn install --frozen-lockfile
RUN yarn run build

FROM node:12.15.0-alpine
ENV NODE_ENV=production
WORKDIR /home/service/rooms-service
COPY --from=rooms-service-builder /home/service/rooms-service/build ./build
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --no-cache --production
CMD yarn start