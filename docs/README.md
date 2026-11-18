# Outrunner documentation

Start with the [project overview](../README.md),
[development setup](development.md), or [contribution guide](../CONTRIBUTING.md).

## Setup and operations

| Guide | Covers |
| --- | --- |
| [Development](development.md) | Toolchains, environment variables, tests, and source builds |
| [Supabase](../supabase/README.md) | Migrations, authentication, and schema verification |
| [Cloudflare deployment](deploy-cloudflare.md) | Containers, secrets, domains, cron, and rollout |
| [Railway deployment](deploy-railway.md) | An alternative control-plane host |
| [VM deployment](deploy-vm.md) | Docker Compose hosting on a VM, without Cloudflare Containers |
| [Desktop app](../runtime-desktop/README.md) | Building the Mac shell and running local sessions |
| [Desktop installation](../runtime-desktop/INSTALL.md) | Installing and releasing a Mac build |
| [Desktop onboarding](desktop-onboarding.md) | Browser sign-in and native handoff |
| [Observability](operations/observability.md) | Health, logs, error reporting, and background work |
| [Codex rollout](operations/codex-rollout.md) | Schema, CLI version, and rollout checks |
| [Billing overage](billing-overage.md) | Metering and optional Stripe overage billing |
| [Memory autoscaling](memory-autoscaling.md) | Sandbox memory limits and growth |
| [Security](../SECURITY.md) | Vulnerability reporting and deployment trust boundaries |
| [Open-source release](operations/open-source-release.md) | Maintainer checks, GitHub settings, fork releases, and existing databases |

The deployment guides include the hosted service's domains and settings. Use
infrastructure and credentials you control for a separate installation.

## Sessions and tooling

- [REST API, CLI, and MCP](api.md)
- [Sessions, shared agent accounts, triage, and notifications](sessions.md)
- [Missions and Ships](missions.md)
- [Previews and access control](previews.md)
- [Agent desktop tools](desktop.md)
- [Media uploads and recordings](media.md)
- [Pull request evidence](pr-evidence.md)
- [Doppler and Infisical secret sync](secret-sync.md)
- [Google Cloud sandboxes](gcp-sandboxes.md)
- [Isolated browser tests](../test/browser/README.md)
- [Live Codex verification harness](../scripts/codex-live/README.md)

## Integrations

- [GitHub App, user connections, and personal tokens](github-app.md)
- [GitLab repositories and merge requests](gitlab.md)
- [Slack](slack-app.md)
- [Linear](linear-app.md)
- [Jira](jira-app.md)

## Design history

[Architecture notes](architecture/README.md) include earlier milestone plans,
spikes, and contracts. They explain design decisions and may describe features
before later changes; consult current code and feature guides for behavior.
The [Cursor migration](cursor-migration.md) is a proposal, not a supported
installation path.
