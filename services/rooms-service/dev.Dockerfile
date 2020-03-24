FROM node:12.15.0-alpine
WORKDIR /home/service/rooms-service
COPY ./package.json ./
RUN yarn
COPY . .
CMD yarn run dev