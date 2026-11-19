# syntax=docker/dockerfile:1

# Control-plane image for Cloudflare Containers — the same `pnpm start` app as
# the Railway setup. In this repo the cross-compiled runtime-agent binary is a
# gitignored build artifact (see .gitignore / scripts/build-agent.sh), so the
# image BUILDS it rather than expecting a committed copy, then serves the whole
# app on disk (not a standalone bundle) so lib/runtime/daytona-provider.ts can
# read it at runtime.

# Base images are pinned by digest, so a tag can't change under a build. To
# bump one: its new tag's index digest, e.g.
#   docker buildx imagetools inspect node:22-slim
# (keep golang's minor in step with runtime-agent/go.mod).

# Layers are ordered so a typical change rebuilds only the app: dependencies
# are installed from the manifests alone, before the source is copied, with
# pnpm's store and Go's caches in cache mounts that outlive a build.

# ---- agent: cross-compile runtime-agent to a static linux/amd64 binary -------
FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS agent
WORKDIR /src/runtime-agent
COPY runtime-agent/go.mod runtime-agent/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY runtime-agent/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
    -trimpath -ldflags="-s -w" \
    -o /out/runtime-agent-linux-amd64 ./cmd/runtime-agent

# ---- base node ---------------------------------------------------------------
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS base
RUN corepack enable
WORKDIR /app

# ---- deps: every dependency, from the manifests alone -------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

# ---- prod-deps: what the server needs at runtime, without dev tools -----------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store

# ---- build: next build ---------------------------------------------------------
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* is inlined into the client bundle at BUILD time — Next does not
# read it at runtime. The container's runtime env (set by the Worker) therefore
# never reaches the browser, and the client Supabase constructor throws
# "Your project's URL and API key are required to create a Supabase client!"
# while the server half stays perfectly healthy, because IT does read process.env.
#
# These two are published to every visitor's browser by design, so passing them
# as build args costs nothing. Supplied by cloudflare/wrangler.jsonc image_vars.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_CODEX_CLI_VERSION
# Optional: without it the browser reports no errors (instrumentation-client.ts).
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_CODEX_CLI_VERSION=$NEXT_PUBLIC_CODEX_CLI_VERSION
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" -a -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  || (echo "ERROR: NEXT_PUBLIC_SUPABASE_* build args are empty; the client bundle would ship without them" && exit 1)
RUN node scripts/verify-codex-cli.mjs "$NEXT_PUBLIC_CODEX_CLI_VERSION"
RUN --mount=type=cache,id=next-cache,target=/app/.next/cache pnpm build
# What the runtime takes: the source (server.ts runs it as is) and the built
# .next, without the build's dependencies (next build's cache is a mount, not
# in the image).
RUN mkdir /release && tar -cf - --exclude=./node_modules --exclude=./.next/cache . | tar -xf - -C /release

# ---- runtime: server.ts under tini + the built agent binary -------------------
FROM base AS runtime
ENV NODE_ENV=production
# tini as PID 1: it passes SIGTERM on to node, which drains (server.ts) before
# it exits, and reaps any child left behind. Node as PID 1 would get no
# default signal handling, and `pnpm start` under it didn't pass SIGTERM on.
# The static release binary, checked against its published sha256
# (tini-static-amd64.sha256sum on the release), like every other download.
ADD --checksum=sha256:c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee --chmod=0755 \
  https://github.com/krallin/tini/releases/download/v0.19.0/tini-static-amd64 /usr/bin/tini
# Cloudflare Containers routes to the port the process listens on; `pnpm start`
# runs server.ts (Next plus the Neev WebSocket relay) on ${PORT}. Keep in sync
# with defaultPort in cloudflare/worker.ts.
ENV PORT=8080
# Where daytona-provider.ts reads the agent binary from (relative to /app).
ENV RUNTIME_AGENT_BINARY_PATH=bin/runtime-agent-linux-amd64
# Production dependencies first, their own layer: it changes only with the
# lockfile, so a deploy usually pulls just the small app layer after it.
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=agent /out/runtime-agent-linux-amd64 /app/bin/runtime-agent-linux-amd64
# The app, as the build stage set it out.
COPY --from=build /release /app
# Not root: the image's own `node` user (uid 1000). The app stays root-owned
# and read-only to it; Next's cache is the one place it writes under /app.
RUN mkdir -p /app/.next/cache && chown -R node:node /app/.next/cache
USER node
EXPOSE 8080
# The commit it's built from, for /api/health (cloudflare/worker.ts checks the
# running container is the latest deploy's). Last, so it costs no cache.
ARG OUTRUNNER_BUILD=""
ENV OUTRUNNER_BUILD=$OUTRUNNER_BUILD
# The git tree it's built from: the code itself, whatever commit it's deployed
# as. An image is built once per tree and tagged by it; the VM sets
# OUTRUNNER_BUILD (the commit) as it starts it, and the deploy checks
# /api/health reports both (lib/observability/build.ts).
ARG OUTRUNNER_TREE=""
ENV OUTRUNNER_TREE=$OUTRUNNER_TREE
LABEL org.opencontainers.image.source="https://github.com/outrunner-sh/outrunner"
ENTRYPOINT ["/usr/bin/tini", "--"]
# What `pnpm start` runs, without pnpm and a shell in between to swallow the
# signal (NODE_ENV is set above).
CMD ["node", "--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "server.ts"]
