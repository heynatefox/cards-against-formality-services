FROM node:12.15.0-alpine AS games-service-builder
WORKDIR /home/service/games-service
COPY . ./
RUN yarn install --frozen-lockfile
RUN yarn run build

FROM node:12.15.0-alpine
ENV NODE_ENV=production
WORKDIR /home/service/games-service
COPY --from=games-service-builder /home/service/games-service/build ./build
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --no-cache --production
CMD yarn start