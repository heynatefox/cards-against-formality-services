FROM node:12.15.0-alpine
WORKDIR /home/service/web-gateway-service
COPY ./package.json ./
RUN yarn
COPY . .
ENV NODE_ENV=development
CMD yarn run dev