FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p /app/storage/uploads && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
