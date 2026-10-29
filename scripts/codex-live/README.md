# Isolated Codex account approval check

This operator-only harness exercises the branch app's real settings, CLI upload,
Supabase encryption/authorization/refresh store and inference broker, plus the
branch runtime's native Codex TUI. It needs an account owner's browser approval;
fixtures and a successful device-code request do not prove live inference.

It does **not** publish a release, apply hosted migrations, enable local sessions
in the product, reuse a developer's provider login, or provision a paid sandbox.
The runtimes run here on private tmux sockets with separate HOME directories, roots and runtime secrets.
It exercises the cloud authentication resolver with test org identities. Actual
cloud-provider provisioning remains covered separately by the normal runtime path.

## Prepare and start (Replicas workspace)

Requires Node 24, pnpm dependencies, Go, Docker and tmux. Follow the Replicas
Docker skill to start the daemon if needed. All ports below are dedicated test
ports; **never use the reserved Replicas engine port 3737**.

From a committed branch checkout with installed dependencies:

```sh
node scripts/codex-live/prepare.mjs
replicas service start codex-live-app "node scripts/codex-live/launch.mjs app" --cwd "$PWD"
replicas service start codex-live-runtime "node scripts/codex-live/launch.mjs runtime" --cwd "$PWD"
replicas service start codex-live-runtime-member "node scripts/codex-live/launch.mjs runtime-member" --cwd "$PWD"
replicas service start codex-live-gateway "node scripts/codex-live/gateway.mjs" --cwd "$PWD"
curl -fsS http://127.0.0.1:3408/signin >/dev/null
curl -fsS http://127.0.0.1:3409/health >/dev/null
curl -fsS http://127.0.0.1:3411/health >/dev/null
node scripts/codex-live/run-verify.mjs --preflight
curl -fsS http://127.0.0.1:3410/__test >/dev/null
replicas preview create 3410 --authenticated
```

Record that printed HTTPS origin in `.context/codex-live/preview.json`:

```json
{ "origin": "the exact authenticated preview origin printed above" }
```

Then run `node scripts/codex-live/access.mjs`. It writes a private, single-use
24-hour owner link to `.context/codex-live/owner-link.txt`. Deliver that link only
to the owner/Mothership, **never to PR text, public media, or logs**. The fragment
bootstrap ticket is exchanged for an HttpOnly test session and erased from the
address bar. The preview also requires a Replicas login. Issuing a new link
invalidates old test-launcher sessions; it preserves any Codex connection.

Preparation refuses to overwrite an existing directory or adopt existing test
containers. To resume an existing setup, keep its directory/keys and start the
four services again; do not rerun preparation. It never reads `.env*`. Children
receive only freshly generated local configuration. Supabase/DB/runtime ports
are not published as previews; only the protected gateway is exposed.

Preparation snapshots the commit, builds its CLI/runtime/app, installs official
Codex **0.146.0**, applies all branch migrations in a new Supabase project, and
creates three isolated users: an org admin, a teammate and a nonmember. It
preprovisions a revocable Outrunner CLI token for the isolated admin; this is
**test bootstrap**, not provider authentication. Local legacy Data API default
grants are applied _before_ the migrations, preserving their explicit revokes
and RLS (including service-only access to Codex credentials).

## Exact owner action

1. Open the private owner link in a browser signed into Replicas.
2. Optionally select **Open real Codex settings** to inspect the actual product
   UI as the isolated org admin. Use Back to return. Do not run the settings'
   `npx outrunner@latest` command for this premerge test; that package is still
   the published version. The launcher runs the built branch CLI instead.
3. Select **Start official device login**. Open **Approve on OpenAI**, enter the
   displayed code at `https://auth.openai.com/codex/device`, and approve using
   the intended personal ChatGPT Plus/Pro account. Enable device-code login in
   ChatGPT's security settings if the provider asks. Codes expire in ten minutes;
   select Start again if needed. No installation or terminal command is needed
   on the owner's computer.
4. When Connected, select **Run inference and refresh checks**, or let the agent
   run `node scripts/codex-live/run-verify.mjs` in this workspace.

The CLI runs **in this isolated workspace**, with a new private temporary
`CODEX_HOME`, not in the owner's existing Codex home. Its actual command is the
branch-built `outrunner --url http://127.0.0.1:3408 --account <isolated-admin-UUID>
codex-auth --org <isolated-org-UUID>`, with its test Outrunner sign-in supplied
through a private config file. Controller upload is loopback; OpenAI login and
provider calls use HTTPS. The gateway checks the preview's browser Origin before
translating Origin/Host to the loopback app, which still performs its real
Supabase authentication, role and CSRF checks. No provider OAuth token is sent
to the browser or runtime computer.

Approval allows **this isolated organization's current test members** to use
the connected subscription through the broker. It does not connect the production
org or copy credentials to production. The short live inference turns use the
account's normal subscription allowance. The provider's own approval screen is
the source of truth for its login permissions.

The verifier selects a model actually returned by the authenticated native
catalog, resolves the connection for admin/teammate through the real resolver,
starts two actual runtime/TUI sessions on independent runtime roots/processes, forces twelve concurrent central refresh
requests (one revision), stops/resumes a session, and checks inference after
refresh. It also verifies nonmember denial, retained-grant denial after member
removal, and saved API-key choice precedence. Membership and choices are restored
in `finally`, and the two runtime sessions are destroyed after every run.
Reports contain pass/fail stages and HTTP statuses, never raw provider bodies,
headers, credentials or arbitrary exceptions. Provider model availability/menu
compatibility must be reported from the actual catalog, not assumed.

## Cancel, revoke and remove

Cancel in the real settings stops the CLI by its regular status poll; the
launcher also sends the CLI an interrupt. Both remove its temporary native login
files and cancel its upload attempt. Browser cancellation/expiry does not remove
an already-connected replacement's predecessor.

Disconnect in the real settings, or **Disconnect and clear test sessions** in
the launcher, clears the encrypted provider credential and changes its generation.
Future broker requests are denied, including those using previously retained
computer grants. An already-running provider request can finish. Disconnect is
Outrunner-side revocation; use the provider's own security controls for provider-
side revocation. Unrelated personal logins are not read, modified or logged out.

When testing is complete, the operator should first disconnect and verify denial,
then stop only these four services and delete only the isolated Supabase project:

```sh
node scripts/codex-live/run-verify.mjs --cleanup
replicas service stop codex-live-gateway
replicas service stop codex-live-app
replicas service stop codex-live-runtime
replicas service stop codex-live-runtime-member
pnpm exec supabase --workdir .context/codex-live/stack stop --no-backup
```

Finally remove `.context/codex-live` (isolated DB keys, encryption key, CLI sign-in,
bootstrap ticket and test files) after checking that no further verification is
needed. `--no-backup` removes that project's Docker data; never substitute a
hosted DB URL or another project. No production migration/release is required to
run this check. Production rollout still requires the Codex migration, controller
and compatible runtime/CLI release described in the architecture document.
