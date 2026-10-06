# Installing Outrunner

`Outrunner_<version>_universal.dmg` — universal (Intel + Apple Silicon),
Developer ID-signed and Apple-notarized. Download it from the latest
[GitHub Release](https://github.com/neevai-labs/outrunner/releases).

## Before you start

The app is a thin shell around **https://outrunner.neev.ai**, which is live.
It has no local fallback, so if that site is ever down the window opens blank.

Because it is a shell, web changes reach you on next launch with no reinstall.
Native changes (the Claude connect flow, the tray, the sign-in listener) ship as
a new release — and because the app is set up for **auto-update**, an installed
copy downloads and applies those on its own at next launch.

## Install

1. Open the DMG and drag **Outrunner** to Applications.
2. Launch it normally.

That's it — no `xattr`, no "Open Anyway" step. The build is signed with an Apple
Developer ID certificate and notarized by Apple, so Gatekeeper opens it without a
warning.

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

## Updates

Installed apps check the latest GitHub Release on launch and, if a newer signed
build exists, download and apply it in the background, then relaunch. No manual
re-download.

## Known limits

- Closing the window keeps the app in the menu bar. Use **Quit Outrunner** from
  the tray menu to exit.

---

## Release smoke checklist (maintainers)

CI already fails a release unless the artifact is signed, notarized and stapled
(see `.github/workflows/release-desktop.yml`). Two things a headless runner
cannot honestly prove, so verify them by hand once per release:

1. **Clean-Mac download opens with no prompt.** On a Mac that has never seen the
   app, download the DMG *through a browser or Slack* (so it gets the
   `com.apple.quarantine` attribute a real user's download gets), install, and
   confirm it launches with **no** Gatekeeper warning and **no** `xattr` step.
2. **One real update hop.** With version N installed, publish N+1, relaunch N,
   and confirm it self-updates to N+1.
