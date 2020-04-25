FROM node:12.15.0-alpine AS cards-service-builder
WORKDIR /home/service/cards-service
COPY . ./
RUN yarn install --frozen-lockfile
RUN yarn run build

FROM node:12.15.0-alpine
ENV NODE_ENV=production
WORKDIR /home/service/cards-service
COPY --from=cards-service-builder /home/service/cards-service/build ./build
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --no-cache --production
CMD yarn start