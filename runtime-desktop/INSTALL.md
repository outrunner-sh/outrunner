# Installing Outrunner (team build)

`Outrunner_<version>_universal.dmg` — universal (Intel + Apple Silicon), signed
with our Developer ID and notarized by Apple. Download it from the repository's
GitHub Releases.

## Before you start

The app is a thin shell around **https://app.outrunner.sh**, which is live.
It has no local fallback, so if that site is ever down the window opens blank.

Because it is a shell, web changes reach you on next launch with no reinstall.
Native changes (the Claude connect flow, the tray, the sign-in listener) arrive
as updates: the app checks shortly after launch and every few hours, installs
a new version in the background, and asks you to **Restart**. Choosing
**Later** is fine; the next launch runs the new version. To check by hand, use
**Check for Updates…** in the tray menu.

## Install

Open the DMG and drag **Outrunner** to Applications, then launch it. macOS
checks the notarization ticket and opens it with no warning or extra step.

Builds before 0.2.0 were ad-hoc signed and needed
`xattr -dr com.apple.quarantine /Applications/Outrunner.app`; that is no longer
necessary. Replacing one of those builds signs you out once, because the app's
identifier changed (`ai.zerotrail.runtime` → `ai.neev.outrunner`).

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

- Closing the window keeps the app in the menu bar. Use **Quit Outrunner** from
  the tray menu to exit.
