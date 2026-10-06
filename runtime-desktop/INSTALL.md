# Installing Outrunner (team build)

`Outrunner_0.1.0_universal.dmg` — universal (Intel + Apple Silicon), ad-hoc signed.

## Before you start

The app is a thin shell around **https://outrunner.neev.ai**, which is live.
It has no local fallback, so if that site is ever down the window opens blank.

Because it is a shell, web changes reach you on next launch with no reinstall —
a new DMG is only needed for native changes (the Claude connect flow, the tray,
the sign-in listener).

## Install

1. Open the DMG and drag **Outrunner** to Applications.
2. Run this once, then launch normally:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Outrunner.app
   ```

Without it macOS refuses to open the app. Slack (or your browser) stamps
downloaded files with a `com.apple.quarantine` attribute, and because this
build is ad-hoc signed with no team identifier, Gatekeeper cannot attribute
it to a known developer. The command clears that attribute for this one app.

If you would rather not run a command: launch it, let it fail, then approve it
under **System Settings → Privacy & Security → Open Anyway**. Same result.

Do NOT disable Gatekeeper globally (`spctl --master-disable`) — that turns the
check off for everything you ever download, not just this.

### Why macOS blocks it

The build carries an ad-hoc signature with no team identifier, so Gatekeeper
cannot attribute it to a known developer:

```
Signature=adhoc
TeamIdentifier=not set
```

This is a property of how it was built, not of what it does. Signing and
notarizing it properly needs an Apple Developer ID Application certificate,
after which it installs with no warning at all.

## First run

1. **Continue with GitHub** — authorization opens in your real browser, not in
   the app window. That is deliberate: GitHub blocks embedded webviews, and the
   browser's URL bar is your anti-phishing signal. The app listens on
   `127.0.0.1:47823` for the redirect (RFC 8252).
2. **Settings → Claude → Connect Claude** — runs `claude setup-token` on your
   own machine and stores the result encrypted. Approve in the browser and it
   finishes by itself; you never handle the token.
   Requires Claude Code installed locally (`claude` on your PATH).
3. Your workspaces then run on **your** Claude subscription, not a shared one.

If Connect Claude reports that Claude Code isn't installed, install it and
relaunch — the app looks for `claude` in the usual Homebrew, `~/.local/bin` and
`~/.claude/local` locations, since a GUI app does not inherit your shell PATH.

## Local sessions

When you start a session, **This Mac** runs Claude Code on your machine instead
of a cloud box, in any folder you choose — it doesn't have to be on GitHub. A git
folder gets its own worktree per session (under `~/.outrunner/workspaces`), so
your files are untouched until you merge; any other folder is edited directly.
It uses your own `claude` login, so it needs no Claude connection in Settings.
Your local sessions are listed under **This Mac** in the sidebar.

It needs `git`, `claude` and **tmux** on your shell's PATH:

```bash
brew install tmux
```

Local sessions start in *accept edits* mode: Claude edits files freely but asks
before running shell commands. Answer those in the session's Terminal panel.
Quitting the app leaves Claude running; reopening the workspace reattaches.

## Known limits

- **Unsigned** (ad-hoc), as above — the Privacy & Security step is required
  once per install.
- Closing the window keeps the app in the menu bar. Use **Quit Outrunner** from
  the tray menu to exit.
