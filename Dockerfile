FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js notifier.js ./
COPY public/ ./public/

EXPOSE 2545

CMD ["node", "server.js"]
