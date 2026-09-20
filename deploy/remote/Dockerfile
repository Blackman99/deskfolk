FROM node:24.12.0-bookworm-slim AS messenger
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/messenger/package.json apps/messenger/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/messenger apps/messenger
RUN pnpm --filter @real-bot/messenger build
COPY deploy/remote/csp.mjs deploy/remote/csp.mjs
RUN node deploy/remote/csp.mjs apps/messenger/build/index.html /app/csp.caddy

FROM caddy:2.10.2-alpine
RUN mkdir -p /srv /config /data && chown -R 1000:1000 /srv /config /data
COPY --from=messenger /app/apps/messenger/build /srv
COPY --from=messenger /app/csp.caddy /etc/caddy/csp.caddy
COPY deploy/remote/Caddyfile /etc/caddy/Caddyfile
COPY deploy/remote/entrypoint.sh /entrypoint.sh
USER 1000:1000
EXPOSE 8080 8443
ENTRYPOINT ["sh", "/entrypoint.sh"]
