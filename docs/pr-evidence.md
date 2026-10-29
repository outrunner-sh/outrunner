# Evidence in pull requests

When a session changes UI or behaviour a person can see, its agent proves it in
the pull request, as a reviewer would want to see it. It runs the app,
reproduces the behaviour on the base branch (**Before**), verifies the change
on its branch in Chromium on the session desktop (**After**), captures
screenshots or a GIF, uploads them, and writes the PR body from the template,
with an Evidence section and a "Verified in the browser" checklist.

## Where the instructions are

- **The template and rules.** `lib/session/pr-template.ts` holds the body's
  structure, the evidence rules, the run-the-app steps and the Outrunner
  footer. Anything that tells an agent how to write a PR reads from it.
- **Create PR.** The button attaches `PR instructions.md`
  (`lib/session/pr-instructions.ts`). It runs the evidence steps before
  `git push` and `gh pr create`. When the push updates an open PR, it refreshes
  the Evidence section with `gh pr edit --body-file`.
- **Standing instructions.** Every cloud session gets the same guide when it
  is created (`CreateWorkspaceRequest.guide`). The box keeps it and appends it
  to the agent's orientation at every launch, after Outrunner's orientation and
  before the project's instructions. So a PR the agent opens on its own, from a
  GitHub mention, an automation, a Runner or a plain "open a PR", is written
  the same way. Sessions created before this don't have it.
- **Which steps a session gets.** Sessions on Daytona (`daytona`,
  `user-daytona`) get the evidence steps, because their boxes have a desktop
  with Chromium (`outrunner_desktop` tools). Modal, Neev and Mac sessions get
  the fallback: use the template anyway, say under Evidence why there is none,
  and leave the browser checklist unchecked with the reason. A missing tool
  never fails the PR.

## The tools on the box

| Need | Tool |
| --- | --- |
| Drive the browser, take screenshots, record | `outrunner_desktop` MCP server: `open_browser`, `browser_snapshot`, `browser_click`, `browser_fill`, `screenshot`, `record_start` / `record_stop` (see `docs/desktop.md`) |
| Make a GIF under GitHub's 5 MB | `outrunner media gif <recording.mp4> [--start] [--duration] [--crop]` |
| Upload and get the markdown | the `upload_media` tool (Claude), or `outrunner media upload <file> --name "…"` (Claude and Codex) |
| Host the files | `docs/media.md` |

## Docker on a Daytona box

Checked on a throwaway sandbox from Daytona's `daytona-medium` snapshot
(2 vCPU, 4 GiB, an 8 GB disk), created with auto-stop and auto-delete, and
deleted afterwards.

- **What the box is.** Debian 13 running as a container under **Sysbox**.
  cgroup v2 controllers are delegated, and root has every capability. `sudo`
  needs no password.
- **Already there.** ffmpeg 7.1 (with libx264, libvpx and gif), Chromium 150,
  git, Node 25 and Python 3.14. A palettegen/paletteuse GIF from a 3 s test
  clip takes under half a second.
- **Docker isn't installed, and installs in about 21 s.** Run
  `curl -fsSL https://get.docker.com | sudo sh`. There is no systemd, so start
  the daemon yourself, in the background, with no special flags:
  `sudo dockerd > /tmp/dockerd.log 2>&1 &`. It uses the overlayfs driver with
  no iptables or cgroup errors, and `/var/lib/docker` is its own volume.
  The `runtime` user needs `sudo chmod 666 /var/run/docker.sock`, or the docker
  group and a new login.
- **What runs.** `hello-world`, published ports (`-p 18080:80` nginx answered
  200), outbound network from containers, and `postgres:16-alpine` (ready in
  about 2 s).
- **Local Supabase works.**
  `npx supabase start -x studio,imgproxy,edge-runtime,logflare,vector,supavisor`
  was healthy in **1 min 40 s** when cold, mostly pulling images. REST and Auth
  answered 200.
- **After the box stops and starts again**, the images survive but `dockerd`
  doesn't. Start it again; the Supabase containers then come back by themselves
  in about 12 s.
- **Memory is tight on `daytona-medium`.** Supabase's containers use about
  900 MiB, and the box sat at its 4 GiB limit (it hit the limit often, but
  nothing was OOM-killed). A session that runs Supabase, a dev server and the
  agent together should use the large size (`daytona-large`, 4 vCPU, 8 GiB).

### When Docker can't be used

The instructions tell the agent, in order:

1. Use what the project documents for development without Docker, for example
   a hosted development Supabase project. Its URL and keys go in the project's
   environment variables (the project's settings → Environment variables), or the agent asks for them with
   `request_secrets`. Never use production keys.
2. Run the parts that don't need Docker (a frontend against a staging API, a
   storybook) and say what wasn't exercised.
3. If nothing runs, still open the PR: say under Evidence why there is none,
   and leave the browser checklist unchecked with the reason.

A project that needs Docker for every session can install and start it in its
start hook (the project's settings → Setup scripts → Start hook), so the agent finds it running.
