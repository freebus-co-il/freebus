# syntax=docker/dockerfile:1

# Built and run as linux/arm64 -- the production target is an arm64 box, and
# the same images run natively on an Apple Silicon dev machine, so nothing is
# emulated at either end.

# ---- build -------------------------------------------------------------
# better-sqlite3 is a native addon. It publishes arm64 prebuilds, but the
# toolchain is kept here anyway so a prebuild miss falls back to compiling
# instead of failing the build outright.
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

# Drop dev dependencies from the tree that gets copied forward. Rebuilt from
# the lockfile rather than pruned so the native addon is definitely the one
# linked against this image's own libstdc++.
RUN rm -rf node_modules && npm ci --omit=dev

# ---- runtime -----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Absolute, so they do not depend on where `dist` happens to sit relative to
# a "repo root". config.ts derives its default from the module's own path
# (`resolve(moduleDir, "..", "..")`), which means the default moves when the
# code is packaged; an absolute override sidesteps that entirely. Both are
# bind mounts shared with gtfs -- see docker-compose.yml.
ENV GTFS_DATA_DIR=/data
ENV TRANSIT_CACHE_DIR=/cache

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Baked train track lines (npm run bake:rail); read from dist/rail/../../assets.
COPY assets ./assets
COPY package.json ./

RUN mkdir -p /data /cache && chown -R node:node /data /cache
USER node

EXPOSE 3100

# /ready, not /health: the process answers /health as soon as it is listening,
# which is BEFORE the RAPTOR index exists, and it cannot answer a single
# journey question until it does.
#
# 35 minutes because that gap was MEASURED, not guessed: on the production
# CX23 (2 shared vCPU) the first boot took ~22 minutes, almost all of it the
# footpath matrix -- 56,224 Valhalla matrix calls at ~53/s, with Valhalla
# pinned at 94% CPU and the API idling at 4% waiting on it. An earlier 15m
# start_period marked the container unhealthy for the last third of a build
# that was proceeding perfectly. The cache means this only recurs when the
# feed's stop set changes enough to invalidate it, not on every daily import.
HEALTHCHECK --interval=30s --timeout=5s --start-period=35m --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
