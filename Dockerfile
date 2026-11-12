FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev
RUN mkdir -p /app/data /app/data/uploads && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/app/data/payrescue.sqlite
EXPOSE 8787
CMD ["node", "server/index.js"]
