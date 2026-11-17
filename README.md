# Outrunner

Run Claude Code and Codex in persistent workspaces, from your browser or Mac.
Each task gets a Git worktree, a terminal, and a conversation you can return to
while the agent keeps working.

[Use Outrunner](https://app.outrunner.sh) · [Documentation](docs/README.md) ·
[Contributing](CONTRIBUTING.md) · [MIT License](LICENSE)

## What you can do

- Run several agents on separate branches in the same repository.
- Work in cloud sandboxes or run local sessions in the Mac app.
- Review changes and pull requests, open live previews, and watch the agent's desktop.
- Connect your own coding-agent subscriptions or provider API keys.
- Share repositories, environments, and agent connections with your organization.
- Start work from triage, GitHub, Slack, Linear, Jira, or scheduled automations.
- Drive sessions from the CLI, REST API, or MCP server.

Cloud sessions use a Go runtime-agent to manage tmux sessions, worktrees,
terminals, and conversation streams. The Next.js control plane handles sign-in,
permissions, credentials, and lifecycle, with Supabase for data and storage.
Cloud compute supports Daytona, Neev, Modal, and user-connected Google Cloud.
The Tauri Mac app also runs the agent locally.

## Get started

Open [app.outrunner.sh](https://app.outrunner.sh) to use the hosted service.
From a terminal:

```sh
npx outrunner@latest
```

The CLI signs you in through your browser and continues onboarding. For another
deployment, use `outrunner --url https://your-app.example.com` or set
`OUTRUNNER_URL`. Agent subscriptions, model APIs, and cloud compute have their
own accounts, terms, and costs.

## Run from source

You need Node.js 22.18 or newer, pnpm 10.26.0, Git, and your own Supabase project.
Cloud sessions also need a configured sandbox provider and the Go toolchain
pinned in [runtime-agent/go.mod](runtime-agent/go.mod).

```sh
git clone https://github.com/outrunner-sh/outrunner.git
cd outrunner
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
```

Before starting:

1. Set the Supabase URL, publishable key, service-role key, and a generated
   `CREDENTIALS_ENCRYPTION_KEY` in `.env.local`.
2. Configure sign-in and apply the database migrations using the
   [Supabase guide](supabase/README.md).
3. For cloud sessions, configure a sandbox provider and run
   `bash scripts/build-agent.sh` to build the agent uploaded to each box.
4. Run `pnpm dev` and open `http://localhost:3000`. Connect your GitHub account
   and coding agent in Settings.

The [development guide](docs/development.md) covers configuration, tests,
architecture, and troubleshooting. Unit tests and browser fixtures can run
without service credentials. The full app requires Supabase; a cloud agent
must be able to reach the control plane at `RUNTIME_BASE_URL`.

For deployment, see [Cloudflare Containers](docs/deploy-cloudflare.md),
[Railway](docs/deploy-railway.md), or [a VM with Docker
Compose](docs/deploy-vm.md). The checked-in Cloudflare config describes
the hosted Outrunner deployment; replace its account, domains, and public
Supabase values before deploying your own instance.

## Repository map

| Path | Contents |
| --- | --- |
| [`app/`](app/) | Next.js pages, authentication, and API routes |
| [`components/`](components/) / [`hooks/`](hooks/) | Web UI and React hooks |
| [`lib/`](lib/) | Session, provider, database, integration, and API logic |
| [`runtime-agent/`](runtime-agent/) | Go runtime-agent, CLI, and desktop tools |
| [`runtime-desktop/`](runtime-desktop/) | Tauri macOS shell and local sessions |
| [`cli-npm/`](cli-npm/) | npm launcher for the platform CLI binaries |
| [`supabase/`](supabase/) | SQL migrations, schema checks, and auth setup |
| [`cloudflare/`](cloudflare/) / [`box/`](box/) | Control-plane deployment and cloud box image |
| [`test/`](test/) | TypeScript tests and isolated browser fixtures |
| [`docs/`](docs/README.md) | Feature, contributor, and operator documentation |

## Development checks

```sh
pnpm check      # typecheck, lint, and TypeScript tests
pnpm build      # production Next.js build
pnpm test:browser
(cd runtime-agent && go build ./... && go vet ./... && go test ./...)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for component-specific checks and pull
request guidelines. To report a vulnerability, follow [SECURITY.md](SECURITY.md).

## Documentation

- [Development and self-hosting setup](docs/development.md)
- [Desktop app and local sessions](runtime-desktop/README.md)
- [CLI, REST API, and MCP](docs/api.md)
- [GitHub App and personal tokens](docs/github-app.md) · [GitLab](docs/gitlab.md)
- [Missions and Ships](docs/missions.md)
- [Previews and access control](docs/previews.md)
- [All documentation](docs/README.md)

## License

Outrunner's original source code is available under the [MIT License](LICENSE).
You can use, modify, self-host, and redistribute it. Third-party dependencies
and bundled assets keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The MIT license does not
provide hosted infrastructure, third-party accounts, or rights to third-party
trademarks.
