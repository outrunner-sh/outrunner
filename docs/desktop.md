# The agent's desktop tools

A session on a Daytona box has a desktop: a 1280×800 Linux screen (1024×768 on
a box made before the desktop came in), which Daytona's computer use runs. The
session's owner watches it in the Desktop tab. The agent uses it through
`outrunner_desktop`, an MCP server that Claude Code and Codex both launch from
the runtime-agent binary (`runtime-agent desktop-mcp --folder <session folder>`,
package `runtime-agent/internal/desktop`).

The desktop starts the first time a tool is used, or when the owner opens the
Desktop tab. Nothing ever stops it: on Daytona, the first screenshot after the
desktop is stopped and started again can crash its computer-use service until
the box restarts.

Sessions on Modal, Neev and the Mac don't get the tools. At each launch, the
runtime-agent checks whether Daytona's toolbox answers on the box's loopback
(`127.0.0.1:2280`).

`outrunner_desktop` is one of Outrunner's own servers, like the Mission's
`outrunner-mission`: names starting with `outrunner` are kept from users and
projects. A session's servers are layered in this order, each over the last:

1. the project's servers;
2. the user's own;
3. Outrunner's servers that the control plane adds (the Mission's);
4. the desktop's, added by the box. Only the box knows it has a desktop, and
   the server runs on the session's folder.

The box drops any server named `outrunner_desktop` from the setup it
receives. Claude is given the desktop's config last; when two `--mcp-config`
files name the same server, Claude uses the last one. Codex is given it as
`-c mcp_servers.outrunner_desktop.*` overrides, which win over its
`config.toml`.

## Tools

The names and outputs below are a contract. The agent's instructions name the
tools, and the pull-request evidence built on recordings relies on them.
Claude knows a tool as `mcp__outrunner_desktop__<name>`, and Codex as
`outrunner_desktop.<name>`.

| Tool | Arguments | Result |
| --- | --- | --- |
| `screenshot` | none | The screen as a JPEG image, and the text `Screenshot of the 1280×800 desktop (coordinates are its pixels), saved to <path>.` |
| `click` | `x`, `y`, optional `button` (`left`, `right` or `middle`) | Text |
| `double_click` | `x`, `y` | Text |
| `drag` | `from_x`, `from_y`, `to_x`, `to_y` | Text |
| `scroll` | `x`, `y`, `direction` (`up` or `down`), optional `amount` (3 if not given) | Text |
| `type` | `text` | Text |
| `key` | `keys`: one key or a chord, e.g. `enter` or `ctrl+shift+t` | Text |
| `open_browser` | `url` | Opens Chromium on the desktop (a new tab if it's open already), then returns the page's snapshot |
| `browser_snapshot` | none | The current tab's accessibility tree, one element a line, each with a ref (`[ref=e123]`) |
| `browser_click` | `ref` | Text naming the page after the click |
| `browser_fill` | `ref`, `text`, optional `submit` | Text |
| `browser_navigate` | `url` | The page's snapshot once it has loaded |
| `record_start` | optional `label` | Text. `structuredContent`: `{ "recording": true }` |
| `record_stop` | none | The text `Saved the recording to <path> (<seconds> s, <size>, MP4 video).` `structuredContent`: `{ "path", "durationSeconds", "sizeBytes" }` |

Pixel coordinates are the screenshot's own pixels. A ref names a DOM node
(Chromium's backend node id), so it stays valid for as long as the element is
on the page.

## Where files land

Screenshots and recordings go in the session's folder, under
`.context/desktop/`. The folder has a `.gitignore` of `*`, so they are never
committed.

- `screenshot-<UTC yyyymmdd-hhmmss-mmm>.jpg`: JPEG, quality 80, with the
  pointer drawn in.
- `recording-<UTC yyyymmdd-hhmmss-mmm>[-<label>].mp4`: H.264 at 30 fps, the
  size of the screen.
  - The timestamp is when the recording stopped.
  - The label is lower-cased, with anything other than letters and digits
    turned into dashes, and cut to 40 characters.
  - One recording runs at a time. It stops by itself after 10 minutes, and
    the next `record_stop` then returns its file.

Daytona records the file in `~/.daytona/recordings/`, and `record_stop` moves
it here.

## The browser

Chromium runs on the desktop with its own profile at
`~/.outrunner/desktop/chromium`, which is shared by the box's sessions, so a
sign-in lasts. Its DevTools listens on `127.0.0.1:19222` only. Like the
desktop's VNC (5900, 5901) and noVNC (6080) ports, that port is never listed
or given a preview link (`DESKTOP_PORTS` in `lib/runtime/box-ports.ts`).
