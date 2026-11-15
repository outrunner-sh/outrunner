# Outrunner Desktop

A lightweight native macOS shell for [Outrunner](https://app.outrunner.sh),
built with [Tauri v2](https://tauri.app). It provides a native window,
menu-bar presence, and a bridge to local agent sessions around the web UI.

It stays thin on purpose. For cloud sessions the web UI opens the terminal
WebSocket **directly to the Daytona box**, so the native layer only provides the
shell and OS niceties — no duplicated frontend, always up to date with the
deploy. Local sessions are the one exception, below.

## What it does today

- **Main window** loads `https://app.outrunner.sh` (system WebView — no
  bundled Chromium, so the app is a few MB).
- **Tray icon + menu**: Show Runtime · New Workspace · Reload · Quit.
- **Left-click the tray** toggles the window.
- **Closing the window quits** the app. Claude sessions survive in tmux and
  reattach on the next launch.
- **Single instance**: launching again focuses the existing window.
- **Self-update** (`src-tauri/src/updater.rs`): release builds check for a new
  version shortly after launch and every 6 hours, install it in the background,
  and offer to restart. The tray also has *Check for Updates…*.

## Local sessions

A session can run on this Mac instead of a Daytona box, in any folder the user
picks — no GitHub repository involved. The app bundles a macOS build of the runtime-agent as a
sidecar and starts it on first use, on `127.0.0.1` and a free port, with a
secret only the app holds (`src-tauri/src/local_runtime.rs`).

The page cannot reach that agent itself: WKWebView blocks `http://` and `ws://`
to loopback from an https page as mixed content. So the app mints the agent's
tokens and relays every call — HTTP over `local_agent_request`, the PTY and
conversation WebSockets over `local_socket_*` with a Channel per socket.

- A git folder gets a worktree per session, in `~/.outrunner/workspaces/<id>`,
  on a new branch off the folder's current commit; the branch stays in the
  folder's repository after the session is destroyed, in case it holds unpushed
  work. Any other folder is edited in place, and destroying only forgets it.
- Local sessions are not in the shared database. The agent's records
  (`~/.outrunner/facts/`) are the list, which the app reads with
  `local_list_sessions`; the session page is `/local/<id>`.
- Sessions run on a private tmux server (`tmux -L outrunner`, no user config),
  so they survive quitting the app and never mix with the user's own tmux.
- Claude uses the user's own `claude` login and starts with
  `--permission-mode acceptEdits`: edits go through, shell commands wait for
  approval in the Terminal panel. Cloud boxes keep `bypassPermissions`.
- Needs `git` and a connected coding agent. The app bundles tmux and can
  manage Claude Code; it reports missing tools when setting up a session.
- The agent's log is `~/.outrunner/agent.log`.

## Planned next (needs a small web API + a webview→Rust bridge)

- Live workspace **status dots** in the tray (running / needs-input / exited),
  polled from the control-plane API.
- **Native notifications** on session state changes.
- **Global hotkey** to summon the window / start a New Workspace.
- Launch-at-login.

## Develop

Develop on macOS with Xcode Command Line Tools, Rust, Bun, and the Go
version pinned in `runtime-agent/go.mod`. Start the control plane first with
`pnpm dev` in the repository root, using [the development setup](../docs/development.md).
Then, from this directory:

```bash
pnpm install --ignore-workspace --frozen-lockfile
pnpm tauri dev         # debug builds use http://localhost:3000
```

Bun is required because Tauri's before-build hooks use `bun run`. The checked-in
lockfile is pnpm's; use pnpm to update dependencies.

Both `tauri dev` and `tauri build` first run `bun run sidecars`, which builds the
agent with `scripts/build-agent-desktop.sh` (needs Go ≥ 1.27; `runtime-agent/go.mod` pins the toolchain) and tmux with
`scripts/build-tmux-desktop.sh` (from pinned source, about a minute the first
time, then skipped while current). The app ships tmux so This Mac sessions need
no tmux installed. Run it by hand before a bare `cargo build` or `cargo test`,
which fail without the sidecars.

## Build a distributable .app / .dmg

```bash
pnpm tauri build      # outputs to src-tauri/target/release/bundle/
```

A local build is unsigned. Builds for the team come from CI instead.

## Release a signed .dmg

```bash
git tag desktop-v0.2.0 && git push origin desktop-v0.2.0
```

`.github/workflows/desktop-release.yml` builds a universal DMG, signs it with
the Developer ID certificate, has Apple notarize it, and attaches it to a draft
GitHub Release for that tag. Smoke-test the DMG, then publish the draft. The
version comes from the tag (`MAJOR.MINOR.PATCH`), not `tauri.conf.json`. A
release, once published, is never rebuilt over: fix forward with a new tag.

Publishing the draft runs `.github/workflows/desktop-publish.yml`, which
copies the DMG to the public download bucket. The link to share is
`<DOWNLOADS_BASE_URL>/outrunner/Outrunner.dmg`, always the latest published
version; `outrunner/latest.json` says which version that is. Publishing only
moves that link forward, so a stale draft published late never replaces a
newer release. To roll back on purpose, run that workflow by hand with the
older tag.

Installed apps update themselves from that same `latest.json`. It doubles as
the updater's manifest: the release also builds a signed update bundle
(`Outrunner_<v>_universal.app.tar.gz`), and the app installs it only if its
signature matches the public key in `tauri.conf.json` (`plugins.updater`). The
private half is the `TAURI_SIGNING_PRIVATE_KEY` secret; keep a backup of it,
because without it no installed copy can ever update again. Updates only move
forward, so a rollback changes what new downloads get, not installed apps; to
undo a bad release for everyone, release a newer fixed version.

To check signing without cutting a release, run the release workflow by hand
from the Actions tab: it does the same build and leaves the DMG as a workflow
artifact.
The secrets and variables both workflows need are listed at the top of each.

## Point at a different environment

The native shell's `site()` function in `src-tauri/src/lib.rs` uses
`http://localhost:3000` for debug builds and `https://app.outrunner.sh` for
release builds. Set `OUTRUNNER_SITE` to override it at launch:

```sh
OUTRUNNER_SITE=https://your-app.example.com pnpm tauri dev
```

The small Vite build is only a Tauri build entry; the native window loads the
configured site directly. There is no separate bundled frontend. For a redistributed fork, also replace the app
identifier, deep-link scheme, updater endpoint and verification key in
`src-tauri/tauri.conf.json`, and update corresponding native defaults. The
upstream updater is signed for Outrunner's official releases.
