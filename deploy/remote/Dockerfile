FROM node:24.12.0-bookworm-slim AS node
FROM oven/bun:1.4.2-slim AS bun

# The phone's page: the NSH app built for the web (`apps/desktop-nsh/scripts/phone-package.ts
# --build`) by the nsh CLI of the commit `apps/desktop-nsh/Cargo.toml` pins, which this stage builds
# from source first (its own layer, kept while the pin stays). Thin LTO keeps that build within a few
# GB of memory. NSH needs Rust 1.97 or later.
FROM rust:1.99-bookworm AS phone
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang llvm \
 && rm -rf /var/lib/apt/lists/* \
 && rustup target add wasm32-unknown-unknown
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && corepack enable && corepack prepare pnpm@12.3.4 --activate
ENV DESKFOLK_NSH_CACHE=/opt/nsh CARGO_PROFILE_RELEASE_LTO=thin CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
    CC_wasm32_unknown_unknown=clang AR_wasm32_unknown_unknown=llvm-ar
WORKDIR /app
COPY apps/desktop-nsh/Cargo.toml apps/desktop-nsh/Cargo.toml
COPY apps/desktop-nsh/scripts/nsh-cli.ts apps/desktop-nsh/scripts/nsh-cli.ts
RUN bun apps/desktop-nsh/scripts/nsh-cli.ts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/desktop-nsh/package.json apps/desktop-nsh/package.json
COPY apps/messenger/package.json apps/messenger/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/remote/package.json packages/remote/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/remote packages/remote
COPY apps/messenger apps/messenger
COPY apps/desktop-nsh apps/desktop-nsh
RUN bun apps/desktop-nsh/scripts/phone-package.ts --build
COPY deploy/remote/csp.mjs deploy/remote/csp.mjs
RUN node deploy/remote/csp.mjs apps/desktop-nsh/build/phone/Deskfolk/index.html /app/csp.caddy

FROM caddy:2.10.2-alpine
RUN mkdir -p /srv /config /data && chown -R 1000:1000 /srv /config /data
COPY --from=phone /app/apps/desktop-nsh/build/phone/Deskfolk /srv
COPY --from=phone /app/csp.caddy /etc/caddy/csp.caddy
COPY deploy/remote/Caddyfile /etc/caddy/Caddyfile
COPY deploy/remote/entrypoint.sh /entrypoint.sh
USER 1000:1000
EXPOSE 8080 8443
ENTRYPOINT ["sh", "/entrypoint.sh"]
