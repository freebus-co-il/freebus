# syntax=docker/dockerfile:1

# See api/Dockerfile for the shared reasoning (arm64 target, why the
# native toolchain is kept in the build stage, why paths are absolute).

# ---- build -------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN rm -rf node_modules && npm ci --omit=dev

# ---- runtime -----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# The same /data that api reads. This service WRITES the SQLite file
# and moves the `gtfs.sqlite` symlink; api notices and reloads on its
# own poll (TRANSIT_RELOAD_POLL_MS).
ENV GTFS_DATA_DIR=/data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000

# This service is a cron holder -- it is healthy when it is listening, which
# is immediately. The interesting state (last import, its outcome) is on
# /status, which is for a human, not for the scheduler.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
