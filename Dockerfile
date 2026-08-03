# syntax=docker/dockerfile:1

# ---------- Stage 1: Build (node) ----------
# Install all deps, build the static UI (vite build) and bundle the Node
# server (esbuild). Throwaway stage; its size does not reach the image.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server.ts ./
RUN npm run build

# ---------- Stage 2: Runtime deps (node) ----------
FROM node:20-alpine AS deps
WORKDIR /deps
RUN npm init -y >/dev/null \
    && npm install --omit=dev --omit=optional --no-audit --no-fund express@4.21.2 \
    && npm cache clean --force

# ---------- Stage 3: Runtime (Bun, ~43MB base) ----------
FROM oven/bun:1-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=deps /deps/node_modules ./node_modules

# Non-root runtime user + su-exec, so the entrypoint can prepare /app/data
# (mkdir + chown even when it's a host bind mount owned by another UID) and
# then drop privileges back to the relay user.
RUN addgroup -S relay && adduser -S -G relay relay \
    && chown -R relay:relay /app \
    && apk add --no-cache su-exec

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Fresh containers (no data mount) bind 0.0.0.0:3000 by default
# (DEFAULT_SERVER_CONFIG). Override via RELAY_PORT/PORT env or a mounted
# config file.

VOLUME ["/app/data"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/local/bin/bun", "dist/server.cjs"]
