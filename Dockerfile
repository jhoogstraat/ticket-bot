FROM oven/bun:1.3.14-debian AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json eslint.config.js ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.14-debian
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
EXPOSE 9080
CMD ["bun", "dist/src/server.js"]
