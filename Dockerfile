FROM node:22-alpine

RUN apk add --no-cache build-base python3

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && rm -rf /root/.npm /tmp/*

COPY . .

EXPOSE 3000

VOLUME ["/app/data"]

CMD ["node", "server.js"]
