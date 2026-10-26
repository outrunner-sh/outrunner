# Outrunner


Outrunner runs the real Claude Code CLI in a persistent cloud workspace you drive
from the browser. You get a live terminal and a structured conversation you can
close your laptop on and reconnect to — the agent keeps running. Conductor-style
workflow, but the session lives in the cloud, not on your machine.

## How it works

- One **Runtime Computer** — a long-lived [Daytona](https://daytona.io) box per
  project, built from a frozen versioned image.
- One **Workspace** = one Claude Code session, in a tmux + git worktree on that
  box.
- A Go **runtime-agent** on the box exposes the live PTY over WebSocket and
  streams the conversation; a Next.js + Supabase control plane handles auth,
  GitHub, and lifecycle.
- Or a **local session**: in the Outrunner Mac app, choose *This Mac*, pick any
  folder, and the same agent runs Claude Code on your machine with your own
  `claude` login — no GitHub repository needed. See
  [`runtime-desktop/README.md`](runtime-desktop/README.md#local-sessions).

## Status

Phase 0 (architecture validated end-to-end on Daytona) and Milestone 1
(foundations) are complete; the interactive execution path is in progress. See
[`docs/architecture/PROGRESS.md`](docs/architecture/PROGRESS.md).

## Local setup

1. Copy `.env.example` → `.env.local`; fill the Supabase and GitHub owner values.
2. Apply `supabase/migrations/*.sql` in filename order (Supabase SQL editor or CLI).
3. `pnpm install && pnpm dev`

`GITHUB_PAT` is server-only, must belong to the configured Outrunner owner, and
needs repo **Metadata: Read**, **Contents: Read/write**, and **Pull requests:
Read/write**. Keep it out of `NEXT_PUBLIC_*` and commits.

## CLI

`npx outrunner@latest` is the one command a new user pastes into their
terminal. It signs the terminal in through the browser (`/cli-login`, PKCE, a
token kept in `~/.outrunner/cli.json`), offers to connect their Claude
subscription when Claude Code is on the computer (it runs `claude setup-token`
under a PTY and saves the token), then continues onboarding in the browser.
`outrunner login | claude | whoami | logout` do one step each; `claude` signs
in first if needed and opens no tab after, so it's what onboarding's
subscription page shows (always with `--url`, the page's own app).
`--url` or `OUTRUNNER_URL` points it at another app.

The CLI is Go (`runtime-agent/cmd/outrunner`), shipped through npm like
esbuild: the `outrunner` launcher (`cli-npm/`) and one `outrunner-<os>-<cpu>`
package per platform. `scripts/build-cli.sh <version>` stages them all.

```sh
cd runtime-agent && go run ./cmd/outrunner --url http://localhost:3000
```

## Docs

- Architecture — [`docs/architecture/runtime-v1-plan.md`](docs/architecture/runtime-v1-plan.md)
- Agent & protocol — [`runtime-agent.md`](docs/architecture/runtime-agent.md), [`protocol.md`](docs/architecture/protocol.md)
- Validation report — [`spike4-runtime-report.md`](docs/architecture/spike4-runtime-report.md)
