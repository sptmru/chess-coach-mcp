FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends stockfish ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM build AS test
CMD ["npm", "test"]
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
