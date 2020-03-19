FROM node:12.15.0-alpine
WORKDIR /home/service/websocket-gateway-service
COPY ./package.json ./
RUN yarn
COPY . .
CMD yarn run dev