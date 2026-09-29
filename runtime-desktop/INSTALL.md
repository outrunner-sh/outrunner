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
2. Launch it. macOS will refuse, because the build is not signed with an Apple
   Developer ID (see below).
3. Open **System Settings → Privacy & Security**, scroll to the bottom, and
   click **Open Anyway** next to the Outrunner message. Confirm.

On some macOS versions right-click → **Open** is enough; on recent ones only
the Privacy & Security route works. Both are the same approval.

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

## Known limits

- **Unsigned** (ad-hoc), as above — the Privacy & Security step is required
  once per install.
- Closing the window keeps the app in the menu bar. Use **Quit Outrunner** from
  the tray menu to exit.
