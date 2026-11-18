# Browser tests that start signed in

A cloud session's computer has a desktop with a Chromium browser, which you can
watch and use in the session's Desktop tab. That browser keeps its sign-ins
between sessions on the same computer. A project's own browser tests
(Playwright's) can start from those sign-ins, so they don't need to sign in
through the UI in every session.

## Use it

1. Sign in to your app once in the Desktop tab's browser.
2. In Playwright's `globalSetup`, write the sign-ins as a `storageState` file
   at a path your repository ignores. Then have every test start from it:

```ts
// global-setup.ts
import { execFileSync } from "node:child_process";

export default function globalSetup() {
  execFileSync("outrunner", [
    "browser", "state",
    "--origin", "http://localhost:3000",
    "-o", "playwright/.auth/state.json",
  ]);
}

// playwright.config.ts
export default defineConfig({
  globalSetup: "./global-setup.ts",
  use: { storageState: "playwright/.auth/state.json" },
});
```

```gitignore
# .gitignore
playwright/.auth/
```

Each test gets a browser context of its own (isolated, as usual) that starts
signed in. For a one-off script, leave out `-o`. The command then writes the
file outside the repository and prints its path:
`browser.newContext({ storageState: path })`.

- **Cookies** are always included, all of them.
- **localStorage** is included for each `--origin`, and for every tab open in the
  browser. Apps that keep their sign-in in localStorage (Supabase's client,
  Auth0's SPA SDK with localStorage caching) need their origin named, unless a
  tab is open on it. Repeat `--origin` for several. Firebase Auth's web SDK keeps
  its sign-in in IndexedDB, which isn't included.
- **Where the file goes.** The file is a live sign-in, readable only by you. Don't
  commit it. With `-o`, the command warns when the path is in a repository and
  not ignored there. Without `-o`, it goes outside the repository, under the
  box's Outrunner folder, one file per session.
- **Expired sign-ins.** A sign-in can expire. When tests land on the sign-in
  page again, sign in again in the Desktop tab, or keep a scripted sign-in in
  `globalSetup` as a fallback.

To drive the desktop browser itself rather than a context of your own (not
isolated: it shares one browser with the agent and the Desktop tab), use
`chromium.connectOverCDP(process.env.OUTRUNNER_BROWSER_CDP_URL)`.

## How it works

```
outrunner browser state ──POST /workspaces/<id>/browser-state (ask token)──▶ runtime-agent
runtime-agent ──DevTools, loopback only──▶ the desktop's Chromium
```

- **Who can read.** Only the session, on its box. The command proves the session
  to the box's runtime-agent with the session's ask token, as
  `outrunner media upload` does. Nothing leaves the box.
- **Cookies** come from the browser's cookie store (`Storage.getCookies`), as
  Playwright reads them from Chromium. A cookie with no SameSite is `Lax`, and a
  session cookie expires at `-1`. Partitioned (CHIPS) cookies are left out.
- **localStorage** is read in a background tab for each origin, then the tab is
  closed. DevTools serves that tab a blank page for the origin (`Fetch`
  interception, with service workers bypassed), so the app's code never runs
  there and the app is never asked for anything. If it ran, it could redirect or
  rotate a token in the middle of the read.
- **One read at a time.** Parallel callers wait their turn rather than each
  opening tabs in the browser you're watching. The file is written atomically,
  so a test never reads half of one.
- **Not included.** IndexedDB and sessionStorage. Sessions on the desktop app's
  Mac don't have the desktop browser.

Code: `runtime-agent/internal/desktop/storage_state.go`,
`runtime-agent/internal/cli/browser_state.go`.
