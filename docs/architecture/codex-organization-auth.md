# Codex account connections

Organization → Coding agents → Codex contains the active organization’s shared ChatGPT connection and OpenAI API-key cards. Page ownership is fixed: Personal never defaults to a team org, and an inaccessible org never falls back to a personal connection. Old provider links to Codex account/default methods keep their active-org destination; explicit API-key/local-method links stay personal, and query parameters/fragments survive the alias.

Personal → Coding agents → Codex offers a private **ChatGPT account** alongside the existing
API-key method. The old Mac-only ChatGPT/local choices are kept as they were;
local sessions remain disabled on the web. No existing choice is rewritten.

A ChatGPT account can be connected at personal scope or once at organization
scope, for current members' cloud sessions on new computers. Whether a given
account's terms permit that use is for the operator to check; this document
describes the technical design only.

## Connect and manage

An organization admin selects the organization explicitly in Settings and starts
a ten-minute attempt. The page shows a command bound to this deployment, signed-in
Outrunner user, organization UUID and attempt UUID:

```
npx outrunner@0.1.4 --url https://app.outrunner.sh --account <user-uuid> codex-auth --org <org-uuid> --attempt <attempt-uuid>
```

The CLI can also start an attempt itself. `outrunner codex-auth` defaults to
**personal**; `--org <UUID>` explicitly selects shared scope. The existing
Outrunner browser login authenticates the CLI. Current admin status is checked
before provider login, again after verification, and inside the SQL upload
transaction. Members may see connection status and use it; they cannot manage it.

The CLI runs the official `codex login --device-auth` in a new, private,
file-backed CODEX_HOME. It prints only the official device URL and approval code,
never raw CLI diagnostics or credentials. It uploads that newly-created login
through HTTPS with its Outrunner CLI bearer token. Existing Codex homes/keychains
are never read or replaced. Temporary login files are removed on every exit.
The browser receives only status and command parameters, never provider tokens.

The server verifies the login against Codex's native model catalog before
committing. Pending attempts are bound to actor and scope; cancel, expiry,
disconnect, admin removal, and replacement prevent a late upload from restoring
old credentials. A pending replacement leaves the working connection intact.
The CLI watches cancellation and stops waiting for device approval.

## Selection and runtime

`user_agent_auth` adds `codex-account`; API-key and legacy Mac choices remain
valid. An explicit pick is honored. Without one, a personal account is preferred,
then a personal API key, then org account/key defaults. An org connection never
silently displaces a personal key. A personal account needing reconnect does not
silently bill the organization instead. Org lookup uses the existing current
`organization_members` role resolver, including after awaited reads.

Each runtime gets a sealed Outrunner inference grant bound to user, session org,
connection scope and generation. It contains **no provider token**. The runtime
uses native Codex's `chatgptAuthTokens` host-managed mode in its isolated home,
an empty refresh token and a local protocol identity. Its custom Responses
provider points to Outrunner over HTTPS with WebSockets disabled (streaming HTTP
is supported by pinned Codex 0.146.0). This is the native CLI's external-token
mode, not a new OpenAI OAuth registration or a service account.

The inference broker allows only models, responses and compaction, targets a
fixed native Codex upstream, forwards compressed bodies/SSE and selected protocol
headers, and supplies the actual fresh access token/account id server-side.
Every request checks the current member, saved method, personal precedence,
connection generation and status in one PostgreSQL authorization snapshot before
upstream use, including after refresh.
Disconnected connections, removed members, and changed choices cannot use stale
computer grants. An already accepted upstream request can finish. Replacement or
disconnect invalidates old grants; reopening/waking the session resolves a fresh
one. Ordinary agent restarts on the same connected generation preserve sign-in.

Provider refresh tokens never reach computers, so there is no distributed
refresh-token cache to rotate or resurrect. Local auth caches contain only
revocable grants, and switching authentication removes them. Both the encoded
grant and its bearer are redacted, including retired grants and live terminals.
ChatGPT cloud plugins/apps are disabled for this connection and are not proxied; this integration supports coding,
models and compaction, plus Outrunner's existing MCP configuration.

## Central lifecycle

`codex_connections` is service-role-only (RLS, no browser grants). AES-256-GCM
uses Outrunner's existing credential encryption and includes the scope inside
the authenticated plaintext. Rows belong to a user or organization with foreign
key cleanup. Metadata is explicitly projected before returning it to settings.

A PostgreSQL RPC acquires one refresh lease per connection across controller
instances. A revision fences concurrent 401 retries; a generation fences
replacement/disconnect. Refresh responses can commit only with their current
lease/generation. The request times out in 15 seconds against a 60-second lease;
crashed workers leave a recoverable lease. Refresh-token rotation is encrypted
and committed centrally before being used. Refresh rejected with invalid_grant,
expired/reused/invalidated refresh token or 401 clears the credential and marks
reconnect. Network failures, 429 and 5xx preserve it, with a short shared retry
cooldown. There is no speculative credential or billing fallback on failures.
As with any rotating-token integration, a process/database outage after the
provider rotates but before commit may require reconnect if the provider later
rejects the retained token; we do not claim to make this external transaction
atomic.

## Sources and validation

Official native behavior is pinned to OpenAI Codex rust-v0.146.0:

- https://learn.chatgpt.com/docs/auth — native CLI/browser and device login.
- https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/login/src/auth/manager.rs — native public client id, refresh JSON contract, external-token mode.
- https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/model-provider-info/src/lib.rs — provider base URL, HTTP and native ChatGPT protocol.

Tests cover personal/API precedence, current-member/org isolation, admin-only
management in SQL, 24 concurrent renewals, rejected-revision deduplication,
rotation, reconnect versus transient failures, stale leases, canceled/expired
uploads, replacement/disconnect races, runtime restart/cache removal and masking.
SQL tests use a disposable database (`CODEX_AUTH_PG`, provided by CI; a dedicated
local Docker test container is also supported). The optional real-CLI probe is:

```
CODEX_TEST_BINARY=/path/to/codex go test ./internal/codex -run AccountNative -v
```

That probe runs the actual pinned CLI through the actual runtime configuration
against a local synthetic upstream, completing an inference response. A second
probe drives the real Service create/start/auth/message flow, real Codex TUI in
a private tmux server, and translated assistant conversation:

```
CODEX_TEST_BINARY=/path/to/codex RUNTIME_TMUX_SOCKET=outrunner-codex-test-probe \
  go test ./internal/workspace -run TestCodexAccountNativeSession -v
```

Both probes use synthetic upstreams; neither needs a real provider login.
The [live Codex verification harness](../../scripts/codex-live/README.md)
exercises the real device login, controller and teammate inference in isolated
containers when a maintainer needs end-to-end evidence.

Rollout requires the migration, normal app/runtime release and a CLI release
containing `codex-auth` via the existing CLI-publish workflow. After verifying
that release, pin its exact version in `cloudflare/wrangler.jsonc` →
`containers[].image_vars.NEXT_PUBLIC_CODEX_CLI_VERSION`. CI and deployment verify
the public executable and pass the pin through Docker at build time. Settings
pins that release; without a configured version it explains the prerequisite
and disables starting an unusable sign-in. It never assumes the mutable
`latest` tag contains this command.
See [rollout and existing-user recovery](../operations/codex-rollout.md).

The isolated harness instead builds with
`NEXT_PUBLIC_CODEX_AUTH_LAUNCHER_PATH=/__test`, so settings links back to the
harness launcher and hides local CLI instructions. The tester only enters the
active device code on OpenAI; the branch CLI already runs in the workspace.
