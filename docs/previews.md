# Previews

A preview is a stable link to a server running on a session's box (a dev
server, an API), that can be shared: `https://<slug>.<RUNTIME_PREVIEW_DOMAIN>/`.
It's a record (`workspace_previews`): a port, a label, who made it, and a
mode:

- **login**: any signed-in member of the session's org who can read its
  repository (Roles & access). A visitor who isn't signed in goes through
  Outrunner's sign-in and comes back to the page they asked for.
- **public**: anyone with the link. The session page asks before it makes
  one public.

They're made from the session's Environment panel, the API
(`/api/v1/workspaces/{id}/previews`, [api.md](api.md#previews)), its MCP
tools (`create_preview` and the rest on `/api/mcp`), or by the session's
agent on its box (`runtime-agent preview <port>`), which makes login
previews only.

## How a request gets through

```
browser ─▶ <slug>.<preview domain> ─▶ Cloudflare Worker ─▶ container: server.ts
                                                             │
                                        lib/previews/proxy.ts ─┤ asks, every ~10 s per visitor:
                                                             │   app/api/previews/gate (loopback)
                                                             ▼
                                               the box's port, through Daytona's preview
                                               proxy (token in a header) or Neev's tunnel
```

`server.ts` takes every request whose host is a preview's, HTTP and
WebSocket alike, before Next sees it: Next never serves a preview's host,
and a preview never serves the app's. The proxy holds no database or
provider code; it asks the app's gate (`lib/previews/resolve.ts`) what to do
with a visitor and keeps the answer about ten seconds. Bytes then pass both
ways as they are, so pages, assets, server-sent events and WebSockets
(hot reload) all work. On Cloudflare the Worker routes the preview domain's
wildcard to the same container and names the host it was asked for
(`x-outrunner-preview-host`, `cloudflare/preview-host.ts`), stripping one a
visitor sent; straight to Node, the Host header does the same.

Signing in, for a login preview:

1. A visitor without a preview session is sent (`302`, page loads only;
   anything else gets `401`) to `https://<app>/previews/<slug>?r=<path>`.
2. The app's sign-in gate sends a signed-out visitor through sign-in and
   back. Signed in, the app checks they may see the preview and sends them
   to `https://<slug>.<domain>/__outrunner/auth?ticket=…&r=<path>`, with a
   ticket good for 60 seconds, for that preview, once.
3. The preview's host trades the ticket for a session cookie of its own,
   `__Host-outrunner-preview` (HttpOnly, Secure, SameSite=Lax, host-only,
   12 hours), and redirects to the path.

What the box's server is sent:

- the path and query exactly as asked, so an OAuth provider's callback or a
  webhook's arrives as sent;
- `X-Forwarded-Host` (the preview's host), `X-Forwarded-Proto`,
  `-Port`, `-For`, `X-Real-IP` and `Forwarded`, replacing any the visitor
  sent;
- `Host`: the preview's own where the way in goes straight to the port
  (Neev), the provider proxy's where that proxy routes by it (Daytona). A
  framework that builds absolute URLs should trust `X-Forwarded-Host`. A
  dev server that checks the Host (Vite's `server.allowedHosts`) needs to
  allow the preview domain and, on Daytona, whatever Host its proxy sends
  (`allowedHosts: true` is simplest for a dev server).
- every cookie but the preview's own session.

What comes back: the box's answer, but a redirect to the provider's host is
pointed at the preview's, every cookie is made host-only (a `Domain`
dropped), and a cookie named as the preview's session is dropped.

OAuth callbacks need the provider to allow
`https://<slug>.<domain>/<callback path>`. A callback that's a page load
(`GET`, the usual) carries the visitor's preview session. One that's a
cross-site `POST` (`response_mode=form_post`) doesn't (SameSite=Lax), so it
needs a public preview; so do webhooks, which come from a server, not a
signed-in browser.

A session asleep (paused or archived), waking or failed shows a page saying
so instead of an error, which loads itself again. To the session's owner it
offers to wake it: a form on the preview's own host (its Origin checked),
which resumes the session as them, as opening it would.

## Threat model

**Who can reach what**

| Who | Login preview | Public preview |
| --- | --- | --- |
| Anyone on the internet | Sent to sign in; nothing of the box's | The port's server, as any visitor |
| Signed-in user outside the org, or without read on the repository | A "can't open" page | The port's server |
| Org member with read on the repository | The port's server | The port's server |
| The session's owner | The port's server; may wake an asleep session | Same |

Nobody, through any preview, reaches the agent's own port (8080) or the
provider's daemon's (2280, 22220, 22222, 33333; `lib/runtime/box-ports.ts`):
refused when a preview is made, and again by the gate on every request,
whatever a row says. Those would be control of the box. Ports below 1024
are refused too.

**Who can make and change previews**

- The session's owner: make, rename, switch mode, delete.
- An org admin: list, make a public one login again, delete. Never make
  one public.
- The session's agent, from its box (its request signed with the box's
  secret, `lib/previews/box-request.ts`, for a session on that box): make
  a login preview, or get the one a port has. Never public: a prompt the
  agent read can't put the user's server on the open web.

Making a preview public, making it login again and deleting one are in the
org's audit log.

**Keeping the preview's code away from the app.** A preview runs whatever
the session's code is, script and all, in the visitor's browser. On the
app's own origin it could read the app's pages and call its routes as the
visitor; under the app's site it could set cookies the app reads and ride
its SameSite cookies. So previews live on a domain of their own:
`RUNTIME_PREVIEW_DOMAIN` on the app's site (the same last two labels as
`RUNTIME_BASE_URL`) is refused and previews stay off. The app's cookies are
never sent to a preview, and the preview's session cookie is HttpOnly, so
the code it serves can't read it; it's stripped before the request reaches
the box, so the box never sees it either.

**Between previews.** Each preview's session cookie is `__Host-` (kept to
its one host, unsettable by any other) and signed for that preview's slug
alone. A box's server can't set a cookie for the whole preview domain
through the proxy (`Domain` is dropped); its script could, with
`document.cookie`, until the domain is on the Public Suffix List. That
reaches other previews' own servers' cookies, never Outrunner's sign-in.

**The link.** A slug is 20 random characters of `[a-z0-9]` (about 103
bits), never reused: a public link can't be guessed, only shared. A ticket
is good for a minute, once (kept spent in the process), and travels with
`Referrer-Policy: no-referrer`; the box never sees one. Tickets and
sessions are signed with a key derived from `CREDENTIALS_ENCRYPTION_KEY`,
each for its own purpose.

**The provider's credential.** The proxy reaches Daytona with the standard
preview link and its token in a header, from the server; neither is ever
sent to a browser. A visitor's own `x-daytona-*` headers are dropped.

**The gate.** `app/api/previews/gate` answers only a call carrying the
secret `server.ts` makes at each start (`OUTRUNNER_PREVIEW_GATE_SECRET`,
in its process alone); to anything else it's a 404.

**How a link is revoked**

- **Delete the preview** (panel, API, MCP; the owner or an org admin): the
  row goes, and with it the link, for everyone, signed in or not, within
  the proxy's ~10 seconds. A new preview of the port is a new link.
- **Switch public to login**: anonymous visitors are sent to sign in within
  ~10 seconds.
- **Take a member's access away** (remove them from the org, or their read
  on the repository): the gate asks Roles & access on every check, so their
  session stops working within ~10 seconds.
- **Delete the session**: its previews are deleted with it (the foreign
  key); an ended session's are refused before that.
- **Pause or archive the session**: its previews show the asleep page; the
  box's server isn't reachable while it sleeps.

A WebSocket opened before a revocation stays open until it closes; the
gate is asked when one opens.

## Setting it up

- `RUNTIME_PREVIEW_DOMAIN`: the domain, e.g. `outrunner-preview.com`. Unset,
  previews are off (the panel shows none, the API answers `503`).
- DNS: a wildcard for it, pointing at the app. On Cloudflare, see
  [deploy-cloudflare.md](deploy-cloudflare.md#previews).
- In development, `RUNTIME_PREVIEW_DOMAIN=localhost:3000` serves previews at
  `http://<slug>.localhost:3000` (browsers resolve `*.localhost` to this
  machine).
