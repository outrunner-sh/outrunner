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

# ---- agent: cross-compile runtime-agent to a static linux/amd64 binary -------
FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS agent
WORKDIR /src
COPY runtime-agent/ ./runtime-agent/
WORKDIR /src/runtime-agent
RUN GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
    -trimpath -ldflags="-s -w" \
    -o /out/runtime-agent-linux-amd64 ./cmd/runtime-agent

# ---- base node ---------------------------------------------------------------
FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS base
RUN corepack enable
WORKDIR /app

# ---- build: install (frozen) + next build ------------------------------------
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
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
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_CODEX_CLI_VERSION=$NEXT_PUBLIC_CODEX_CLI_VERSION
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" -a -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  || (echo "ERROR: NEXT_PUBLIC_SUPABASE_* build args are empty; the client bundle would ship without them" && exit 1)
RUN node scripts/verify-codex-cli.mjs "$NEXT_PUBLIC_CODEX_CLI_VERSION"
RUN pnpm build

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
COPY --from=build /app /app
COPY --from=agent /out/runtime-agent-linux-amd64 /app/bin/runtime-agent-linux-amd64
# Not root: the image's own `node` user (uid 1000). The app stays root-owned
# and read-only to it; Next's cache is the one place it writes under /app.
RUN mkdir -p /app/.next/cache && chown -R node:node /app/.next/cache
USER node
EXPOSE 8080
# The commit it's built from, for /api/health (cloudflare/worker.ts checks the
# running container is the latest deploy's). Last, so it costs no cache.
ARG OUTRUNNER_BUILD=""
ENV OUTRUNNER_BUILD=$OUTRUNNER_BUILD
ENTRYPOINT ["/usr/bin/tini", "--"]
# What `pnpm start` runs, without pnpm and a shell in between to swallow the
# signal (NODE_ENV is set above).
CMD ["node", "--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "server.ts"]
