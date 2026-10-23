# outrunner

Start using [Outrunner](https://app.outrunner.sh) from your terminal:

```sh
npx outrunner@latest
```

It signs the terminal in through your browser, offers to connect your Claude
subscription if Claude Code is on this computer and to bring over the sessions
you have here (Conductor, Claude Code, Codex), and then continues setting up in
the browser.

```
outrunner            sign in if needed, connect Claude, continue in the browser
outrunner login      sign this terminal in
outrunner claude     connect your Claude subscription (runs claude setup-token)
outrunner import     bring sessions on this computer to Outrunner (--all: every one)
outrunner whoami     show who this terminal is signed in as
outrunner logout     sign this terminal out
```
