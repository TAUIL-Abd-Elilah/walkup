# syntax=docker/dockerfile:1.7
#
# Walkup web app as one container: the Next.js standalone server, the
# gazetteer JSON and config/, running as the unprivileged "node" user.
# Persistent state (SQLite cache, plans, quota, spend files, recorded
# fixtures) lives on a volume mounted at /data. See docs/deploy.md.
#
#   docker build -t walkup .
#   docker run --rm -p 3000:3000 -v walkup-data:/data walkup
#
# Needs `output: "standalone"` in apps/web/next.config.ts
# (see docs/deploy.md). The build stops with a clear message
# if the standalone server is missing.
#
# Stages: manifests -> deps (npm ci) -> build (next build) -> runtime.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# base: shared settings for every stage
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
WORKDIR /app

# ---------------------------------------------------------------------------
# manifests: only the lockfile and every workspace package.json, so editing
# source files does not invalidate the npm ci layer below.
# ---------------------------------------------------------------------------
FROM base AS manifests
COPY . /src
RUN find /src -type f ! -name package.json ! -name package-lock.json -delete \
 && find /src -mindepth 1 -type d -empty -delete

# ---------------------------------------------------------------------------
# deps: npm ci from the lockfile, plus a toolchain for better-sqlite3
# ---------------------------------------------------------------------------
FROM base AS deps
# better-sqlite3 ships prebuilt binaries for linux-x64 and linux-arm64.
# python3, make and g++ are here so it can be compiled if a prebuild does not load.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY --from=manifests /src/ ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --include=dev
# Load the native module once; compile it from source only if the prebuild fails.
RUN node -e "const D = require('better-sqlite3'); new D(':memory:').prepare('select 1').get()" \
 || ( echo "better-sqlite3: prebuild did not load, compiling from source" \
      && cd node_modules/better-sqlite3 \
      && rm -rf prebuilds \
      && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --release --force_build=1 \
      && cd /app \
      && node -e "const D = require('better-sqlite3'); new D(':memory:').prepare('select 1').get()" )

# ---------------------------------------------------------------------------
# build: next build of apps/web (standalone output)
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN npm run build --workspace=@walkup/web
RUN test -f apps/web/.next/standalone/apps/web/server.js \
 || ( echo "apps/web/.next/standalone/apps/web/server.js is missing." \
      && echo "Set output: \"standalone\" in apps/web/next.config.ts (see docs/deploy.md)." \
      && exit 1 )
# apps/web has no public/ directory today; create it so the runtime COPY always works.
RUN mkdir -p apps/web/public
# better-sqlite3 for the runtime image: lib/ plus this platform's binary only
# (the package carries binaries for eight platforms). It is a server external,
# so it is required from /app/node_modules at runtime, not bundled.
RUN set -eu; \
    src=node_modules/better-sqlite3; out=/out/node_modules/better-sqlite3; \
    mkdir -p "$out"; \
    cp -R "$src/package.json" "$src/lib" "$out/"; \
    if [ -f "$src/build/Release/better_sqlite3.node" ]; then \
      mkdir -p "$out/build/Release"; \
      cp "$src/build/Release/better_sqlite3.node" "$out/build/Release/"; \
    fi; \
    if [ -d "$src/prebuilds" ]; then \
      mkdir -p "$out/prebuilds"; \
      cp "$src/prebuilds/linux-$(node -p process.arch).node" "$out/prebuilds/"; \
    fi; \
    cd /out && node -e "const D = require('better-sqlite3'); new D(':memory:').prepare('select 1').get(); console.log('better-sqlite3 ok')"

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="walkup" \
      org.opencontainers.image.description="Walkup, the Fill-the-Room Agent" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    WALKUP_MODE=auto \
    WALKUP_DATA_DIR=/data \
    WALKUP_FIXTURES_DIR=/data/fixtures \
    WALKUP_GAZETTEER_DIR=/app/data/gazetteer/out \
    WALKUP_TAGS_FILE=/app/config/tags.json

WORKDIR /app

# The server drops from root to "node" with setpriv (util-linux) after preparing /data.
RUN command -v setpriv >/dev/null

# Standalone server and its traced node_modules. Owned by "node" so Next can
# write .next/cache at runtime.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone/ ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=build /out/node_modules/better-sqlite3 ./node_modules/better-sqlite3

# Read-only runtime data, same layout as the repository.
COPY --from=build /app/data/gazetteer/out ./data/gazetteer/out
COPY --from=build /app/config ./config
# Synthetic fixtures (all labelled "synthetic": true). Linked into
# $WALKUP_FIXTURES_DIR/synthetic at start. Recorded bodies never enter
# the image: they are copied onto the volume (docs/deploy.md).
COPY --from=build /app/fixtures/synthetic ./fixtures/synthetic

# Entrypoint: prepare the volume as root, then run the server as "node".
COPY --chmod=0755 <<'EOF' /usr/local/bin/walkup-entrypoint
#!/bin/sh
set -eu

data_dir="${WALKUP_DATA_DIR:-/data}"
fixtures_dir="${WALKUP_FIXTURES_DIR:-$data_dir/fixtures}"

# Next's standalone server binds to $HOSTNAME. Docker and Fly set it to the
# machine name, which would not accept connections from the proxy.
export HOSTNAME=0.0.0.0

prepare_dirs() {
  mkdir -p "$data_dir" "$fixtures_dir/raw"
  # synthetic/ on the volume is a link to the image's copy, so it always
  # matches the deployed version. A real directory there is left alone.
  if [ -d /app/fixtures/synthetic ]; then
    if [ -L "$fixtures_dir/synthetic" ] || [ ! -e "$fixtures_dir/synthetic" ]; then
      ln -sfn /app/fixtures/synthetic "$fixtures_dir/synthetic"
    else
      echo "walkup: $fixtures_dir/synthetic is a directory; leaving it as is" >&2
    fi
  fi
}

if [ "$(id -u)" = "0" ]; then
  prepare_dirs
  # Fly mounts volumes owned by root; files copied in with `fly ssh sftp` are root-owned too.
  chown -R node:node "$data_dir" "$fixtures_dir"
  export HOME=/home/node USER=node
  exec setpriv --reuid=node --regid=node --clear-groups -- "$@"
fi

# Already unprivileged (for example `docker run --user node`): best effort.
prepare_dirs 2>/dev/null || echo "walkup: cannot prepare $data_dir; is the volume writable?" >&2
exec "$@"
EOF

RUN mkdir -p /data && chown node:node /data

EXPOSE 3000

# Local Docker only; Fly uses the http_service check in fly.toml.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

WORKDIR /app/apps/web
ENTRYPOINT ["/usr/local/bin/walkup-entrypoint"]
CMD ["node", "server.js"]
