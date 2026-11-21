# Browser sign-ins, and browser tests that start signed in

A cloud session's computer has a desktop with a Chromium browser, which you can
watch and use in the session's Desktop tab, and which the agent drives too.
Every session gets a computer of its own. What you or the agent sign in to in
that browser is carried over to your next session on the same repository, so
you sign in to your app (a staging site, say) once, not in every session. A
project's own browser tests (Playwright's) can start from those sign-ins too,
so they don't sign in through the UI either.

## Sign-ins carried over between sessions

- **Whose.** Yours, on one repository. Your next session on it starts with
  them, including one started through the API, Slack or an automation in
  your name. A session someone else started never gets them, nor does a
  session on another repository. Only you can open your session's desktop.
- **What.** The browser's cookies, and the localStorage of each site that had
  a tab open while you used it (a site whose tab you closed keeps what it last
  had). Not IndexedDB or sessionStorage: an app that keeps its sign-in only
  there (Firebase Auth's web SDK) asks you to sign in again.
- **For how long.** 30 days from when they were last saved or used, then
  deleted. A sign-in that expires on its own expires as usual.
- **Encrypted.** Kept in Outrunner's database, encrypted with the key Outrunner
  encrypts your other credentials with, and with your account and the
  repository sealed in with them. Never logged.
- **Turn it off, or forget them.** Settings → Sandbox → Desktop browser: turn
  off *Keep sign-ins between sessions* (which forgets them all), or forget one
  repository's.
- **The agent uses them.** The agent in your next session drives the same
  browser, signed in, as it does in the session you signed in in. So does code
  in the session that drives the browser itself (below). Sign in only where
  you'd let the agent act.

## Browser tests that start signed in

1. Sign in to your app once in the Desktop tab's browser: choose **Browser**
   in the tab (or the globe in the desktop's dock) to open it.
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

### Carried over between sessions

```
runtime-agent ──every 10 s, DevTools──▶ the desktop's Chromium (cookies; open tabs' localStorage)
runtime-agent ──a change, signed with the box's secret──▶ POST /api/runtime/browser-sign-ins {op: "save"}
new session's box ──signed──▶ POST /api/runtime/browser-sign-ins {op: "load"} ──▶ written in at the browser's first start
```

- **Saved as they change.** The box's agent reads the sign-ins every
  10 seconds while the browser runs and sends a change at once, then no more
  than every 30 seconds. So nothing waits on the session's computer being
  paused or archived, which can happen many ways, or not at all. Its first look
  only notes them, so a paused computer that resumes sends nothing it hasn't
  seen change. Each tab's localStorage is read through DevTools' own
  inspection of the page's storage (`DOMStorage`): nothing runs in the app's
  page, and no tab is opened for it.
- **Whose, decided by Outrunner.** The control plane checks the box's
  signature, then reads whose box it is: the one session it was made for, its
  owner and repository (for a session on several, its first). The box never
  says. A repository's shared computer (from before every session had its
  own) keeps none.
- **Back before the first page.** A new session's box asks for them when the
  session is created, if its browser has never run, and leaves them, readable
  only by the box's user, for the browser's first start. Whatever starts it
  takes them, so they're written in once. If the agent opens the browser, it
  starts on a blank tab, writes the cookies (`Storage.setCookies`), writes each
  site's localStorage in a background tab DevTools serves a blank page (as the
  read below does), then shows the page. If you open it from the dock, the
  agent writes them in within a second or so of it starting.
- **Bounded.** Up to 512 KiB. localStorage is left out to fit, the largest
  site's first.
- **Not on the desktop app's Mac**, which has no desktop browser.

Code: `runtime-agent/internal/desktop/sign_ins.go` and `keeper.go`,
`runtime-agent/internal/workspace/sign_ins.go`,
`app/api/runtime/browser-sign-ins/route.ts`, `lib/browser-sign-ins/`.

### `outrunner browser state`

```
outrunner browser state ──POST /workspaces/<id>/browser-state (ask token)──▶ runtime-agent
runtime-agent ──DevTools, loopback only──▶ the desktop's Chromium
```

- **Who can read.** Only the session, on its box. The command proves the session
  to the box's runtime-agent with the session's ask token, as
  `outrunner media upload` does. The file it writes stays on the box.
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
