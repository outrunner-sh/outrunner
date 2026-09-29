# syntax=docker/dockerfile:1

# Control-plane image for Cloudflare Containers — the same `next start` app as
# the Railway setup. In this repo the cross-compiled runtime-agent binary is a
# gitignored build artifact (see .gitignore / scripts/build-agent.sh), so the
# image BUILDS it rather than expecting a committed copy, then serves the whole
# app on disk (not a standalone bundle) so lib/runtime/daytona-provider.ts can
# read it at runtime.

# ---- agent: cross-compile runtime-agent to a static linux/amd64 binary -------
FROM golang:1.22-bookworm AS agent
WORKDIR /src
COPY runtime-agent/ ./runtime-agent/
WORKDIR /src/runtime-agent
RUN GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
    -trimpath -ldflags="-s -w" \
    -o /out/runtime-agent-linux-amd64 ./cmd/runtime-agent

# ---- base node ---------------------------------------------------------------
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# ---- build: install (frozen) + next build ------------------------------------
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- runtime: `next start` + the built agent binary --------------------------
FROM base AS runtime
ENV NODE_ENV=production
# Cloudflare Containers routes to the port the process listens on; `pnpm start`
# is `next start --port ${PORT}`. Keep in sync with defaultPort in cloudflare/worker.ts.
ENV PORT=8080
# Where daytona-provider.ts reads the agent binary from (relative to /app).
ENV RUNTIME_AGENT_BINARY_PATH=bin/runtime-agent-linux-amd64
COPY --from=build /app /app
COPY --from=agent /out/runtime-agent-linux-amd64 /app/bin/runtime-agent-linux-amd64
EXPOSE 8080
CMD ["pnpm", "start"]
