# Runtime Desktop

A lightweight native macOS shell for [Outrunner](https://outrunner.neev.ai),
built with [Tauri v2](https://tauri.app). Conductor-style: a real app window
plus a menu-bar (tray) presence, wrapping the hosted Runtime web UI.

It stays thin on purpose. The web UI already opens the terminal WebSocket
**directly to the Daytona box**, so the native layer only provides the shell and
OS niceties — no duplicated frontend, always up to date with the deploy.

## What it does today

- **Main window** loads `https://outrunner.neev.ai` (system WebView — no
  bundled Chromium, so the app is a few MB).
- **Tray icon + menu**: Show Runtime · New Workspace · Reload · Quit.
- **Left-click the tray** toggles the window.
- **Hide-to-tray**: closing the window keeps the app (and your session)
  running in the tray; use *Quit Runtime* to actually exit.
- **Single instance**: launching again focuses the existing window.

## Planned next (needs a small web API + a webview→Rust bridge)

- Live workspace **status dots** in the tray (running / needs-input / exited),
  polled from the control-plane API.
- **Native notifications** on session state changes.
- **Global hotkey** to summon the window / start a New Workspace.
- Launch-at-login.

## Shipped

- **Auto-update.** Release builds check the latest GitHub Release on launch and
  self-update from a Developer ID-signed, notarized DMG. See
  [INSTALL.md](./INSTALL.md) and `.github/workflows/release-desktop.yml`.

## Develop

```bash
pnpm install
pnpm tauri dev         # launches the app against the hosted site
```

## Build a distributable .app / .dmg

```bash
pnpm tauri build       # outputs to src-tauri/target/release/bundle/
```

Signed, notarized, auto-updating builds are produced only by CI, triggered by
pushing a `desktop-v*` tag (see the release workflow). Because the bundle emits
updater artifacts (`createUpdaterArtifacts`), a local `pnpm tauri build` needs
`TAURI_SIGNING_PRIVATE_KEY` (and its password) in the environment; for day-to-day
work use `pnpm tauri dev`, which skips bundling entirely.

## Releasing

First-time signing/notarization setup (needs Apple Developer access) is a
one-time checklist in [RELEASE_SETUP.md](./RELEASE_SETUP.md). After that:

1. Bump `version` in `src-tauri/tauri.conf.json`.
2. Commit, then tag: `git tag desktop-v<version> && git push --tags`.
   The tag must match the config version or CI fails fast.
3. CI builds the universal binary, signs + notarizes it, verifies the result,
   and publishes the DMG + `latest.json` to a GitHub Release.

## Point at a different environment

The site URL lives in two places: the window `url` in
`src-tauri/tauri.conf.json` and `SITE_URL` in `src-tauri/src/lib.rs`. Change both
(e.g. to `http://localhost:3000`) to run against a local control plane.
