FROM node:24.12.0-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/relay/package.json apps/relay/package.json
COPY packages/remote/package.json packages/remote/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY --from=dependencies /app /app
COPY apps/relay/src apps/relay/src
COPY packages/remote/src packages/remote/src
RUN bun build --target bun apps/relay/src/main.ts --outfile /relay.js

FROM oven/bun:1.4.2-slim
WORKDIR /app
RUN mkdir /data && chown bun:bun /data
COPY --from=build --chown=bun:bun /relay.js /app/relay.js
USER bun
EXPOSE 8080
CMD ["bun", "/app/relay.js"]
