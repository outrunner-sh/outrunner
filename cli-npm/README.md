# outrunner

Start using [Outrunner](https://app.outrunner.sh) from your terminal:

```sh
npx outrunner@latest
```

It signs the terminal in through your browser, offers to connect your Claude
subscription if Claude Code is on this computer, and then continues setting up
in the browser.

```
outrunner            sign in if needed, connect Claude, continue in the browser
outrunner login      sign this terminal in
outrunner claude     connect your Claude subscription (runs claude setup-token)
outrunner whoami     show who this terminal is signed in as
outrunner logout     sign this terminal out
```

## Google Cloud sandboxes

Run `npx outrunner@latest sandbox connect gcp` to connect a billing-enabled
Google Cloud project. Requires gcloud and permission to configure IAM and
networking. The wizard uses keyless federation, verifies a temporary VM,
and asks before selecting GCP for new sessions. See
[the setup and teardown guide](https://github.com/neevai-labs/outrunner/blob/main/docs/gcp-sandboxes.md).
