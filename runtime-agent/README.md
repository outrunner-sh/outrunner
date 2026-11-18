# Outrunner runtime-agent and CLI

This Go module contains the agent running on cloud computers and in the Mac app,
plus the terminal CLI. The control plane provisions and authenticates the agent;
see the [development guide](../docs/development.md) for the complete app setup.

| Path | Purpose |
| --- | --- |
| `cmd/runtime-agent/` | Agent server, MCP tools, and session utilities |
| `cmd/outrunner/` | User-facing `outrunner` CLI |
| `internal/workspace/` | Session lifecycle, worktrees, prompts, and agent processes |
| `internal/conversation/` | Claude conversation decoding and streaming |
| `internal/codex/` | Codex rollout translation |
| `internal/protocol/` | Wire types shared with the TypeScript control plane |
| `internal/cli/` | Terminal login and API commands |

## Build and check

Use the Go toolchain pinned in `go.mod`. From this directory:

```sh
go build ./...
go vet ./...
go test ./...
```

Tests use disposable files and local servers. Install `git`, `tmux`, `sqlite3`,
and `ffmpeg` to exercise their integration paths. The import tests need
`sqlite3`; some optional-tool tests skip when their executable is unavailable.
Cloud-provider and model credentials are not needed for the unit suite.

From the repository root, `bash scripts/build-agent.sh` builds the static
Linux agent the control plane uploads. `bash scripts/build-agent-desktop.sh`
builds Mac sidecars, and `bash scripts/build-cli.sh <version>` stages CLI npm
packages for all supported platforms under `.context/cli-npm/` without
publishing them.

## Protocols and fixtures

Keep protocol changes aligned with `lib/runtime/agent-protocol.ts` and their
golden fixtures. Recorded sessions should use toy repositories and synthetic
credentials. Replace ignored provider prompts, tool schemas, and unrelated
metadata before committing a transcript. Preserve the record shapes needed to
exercise the decoder.

Codex's golden translation uses byte offsets in record IDs. After deliberately
editing its source fixture, regenerate it with:

```sh
go test ./internal/codex -run '^TestTranslateARealRollout$' -update
```

Review the resulting diff and run the complete package tests. Byte-offset
changes alone should not change rendered messages, tool calls, or usage.

## License

Outrunner's original code uses the repository's [MIT License](../LICENSE).
The [third-party notices](../THIRD_PARTY_NOTICES.md) cover bundled Go modules
and tools; CLI and desktop distributions must preserve those notices.
