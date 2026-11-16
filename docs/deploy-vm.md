# Deploy Outrunner directly on a Linux VM

The control plane runs as a Node service behind Caddy. Supabase continues to
provide the database, authentication, and object storage; existing Daytona or
Neev computers remain with their current provider. Docker, Cloudflare Workers,
and Durable Objects are not needed to run this deployment.

Use a Linux VM with systemd. For an on-host production build, start with
4 vCPUs, 8 GB RAM, and 40 GB disk; smaller hosts can run a release built on a
compatible larger Linux machine. The examples use Ubuntu 24.04, the
`outrunner` service user, and `https://app.outrunner.sh`.

## Prepare the host

Install Node **22.18 or later in the Node 22 series** at `/usr/bin/node`,
Corepack/pnpm (the version in `package.json`), Go (the version in
`runtime-agent/go.mod`), Caddy, Git, curl, and the native build tools required
by the dependencies. Use the providers' official installation instructions.

Allow inbound SSH from the operator's addresses and HTTP/HTTPS on ports 80
and 443. **Keep port 3000 private using the VM firewall/security group**:
the application must be reachable publicly through Caddy only. Caddy removes
untrusted `CF-Connecting-IP` headers and supplies the forwarded client address.

Create the user and directories:

```sh
sudo useradd --system --create-home --home-dir /opt/outrunner --shell /bin/bash outrunner
sudo install -d -m 0755 /opt/outrunner/releases /usr/local/lib/outrunner
sudo chown outrunner:outrunner /opt/outrunner/releases
sudo install -d -o root -g outrunner -m 0750 /etc/outrunner
```

Install the deployment files from a reviewed checkout:

```sh
sudo install -m 0644 deploy/vm/outrunner.service deploy/vm/outrunner-cron.service deploy/vm/outrunner-cron.timer /etc/systemd/system/
sudo install -m 0644 deploy/vm/tick.mjs /usr/local/lib/outrunner/tick.mjs
sudo install -m 0755 deploy/vm/build-release.sh /usr/local/lib/outrunner/build-release.sh
sudo install -m 0755 deploy/vm/activate-release.sh /usr/local/sbin/outrunner-activate-release
sudo systemctl daemon-reload
```

Keep the cron timer stopped during migration. It is enabled after the old
scheduler has stopped. Review the supplied Caddyfile before installing it;
preserve any existing sites served by the VM's Caddy instance.

## Preserve production configuration

Create `/etc/outrunner/runtime.env`, owned by root with mode `0600`. It is a
systemd `EnvironmentFile`, kept outside release directories and source
archives. Copy the current production values rather than generating a new
configuration:

- `RUNTIME_BASE_URL=https://app.outrunner.sh`, the existing `RUNTIME_PROVIDER`,
  and the existing `RUNTIME_BILLING`/overage settings.
- The same `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and
  `SUPABASE_SERVICE_ROLE_KEY`.
- **The exact existing `CREDENTIALS_ENCRYPTION_KEY`.** Replacing this key makes
  stored credentials unreadable; an existing Supabase database requires the
  same key on every server sharing it.
- The existing provider keys, GitHub App credentials, cron secret, Stripe,
  OpenRouter, email, monitoring, and integration settings that production uses.
- Preserve the preview domain when configured. Follow [Previews](previews.md)
  for its separate-site and wildcard-host requirements; the supplied Caddyfile
  covers the app hostname only.

The [environment example](../.env.example) lists supported settings. Encode a
multiline GitHub private key as a double-quoted value with literal `\n`
sequences; `lib/github/app.ts` converts them back to newlines. Do not source
this secret file in a build shell or print it in logs.

Create `/etc/outrunner/cron.env`, also root-owned `0600`, containing only the
same `BILLING_CRON_SECRET`. This avoids giving the scheduler unrelated app
credentials. systemd reads these files before switching to the service user.

Separately, create `/etc/outrunner/build.env` with just these public build
values, owned by `root:outrunner` with mode `0640`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-public-key
NEXT_PUBLIC_CODEX_CLI_VERSION=the-supported-version
```

Use the current production public values and supported CLI pin. The existing
hosted pin is recorded in `cloudflare/wrangler.jsonc`; it is build input, not a
runtime dependency on Cloudflare.

## Build and activate an exact release

Fetch `origin/main` and select the commit that passed CI. Archive only that
commit; do not upload a working directory containing `.env` files or local
artifacts. On the deployment machine:

```sh
sha=$(git rev-parse origin/main)
git archive --format=tar "$sha" > /tmp/outrunner-source.tar
```

Transfer the archive to the VM using SSH. Create a **new** release directory
named after that SHA, owned by `outrunner`, and extract the archive there as
that user. Do not overwrite a release that is currently running. Run the
build helper as `outrunner`, with only the public build values exported:

```sh
set -a
. /etc/outrunner/build.env
set +a
/usr/local/lib/outrunner/build-release.sh "/opt/outrunner/releases/$sha" "$sha"
```

The helper installs the frozen dependencies, builds the Linux agent and Next
app, verifies the CLI pin, and records the SHA in `.env.build`. Runtime secrets
are read only when the systemd service starts.

Apply any pending database migrations before activation; existing deployments
should check the [migration recovery notes](../supabase/README.md). Then:

```sh
sudo /usr/local/sbin/outrunner-activate-release "$sha"
sudo systemctl enable outrunner.service
```

Activation switches `/opt/outrunner/current`, restarts the service, and checks
both `ok: true` and the exact build SHA on localhost. If that fails, it restores
the previous VM release when available. Inspect logs with
`journalctl -u outrunner.service`.

## Migrate the public hostname and scheduler

1. Test the candidate VM before routing production to it: localhost health,
   authenticated health, HTTPS through Caddy, sign-in/callbacks, an existing
   session, a new session, conversation streaming, and terminal WebSockets.
   A temporary validation hostname needs its own Caddy site and Supabase
   redirect allowlist entry. Keep the production callback settings intact.
2. Set the repository Actions variable **`PRODUCTION_TARGET=vm`** before
   cutover. The legacy Cloudflare deployment workflow then stands down, so a
   later merge cannot reclaim the hostname. Its guard must be on `main` before
   relying on the variable. Future VM deployments use the build/activate flow
   above; this initial setup does not install an automatic VM deployment job.
3. Save the existing Worker custom-domain binding and DNS record for
   `app.outrunner.sh`. Remove the Worker's binding for that hostname, then point
   its DNS record at the VM. A Worker custom domain intercepts requests, so
   changing an A record alone is insufficient. Use DNS-only routing initially
   so Caddy can obtain and serve its certificate directly. Keep
   `RUNTIME_BASE_URL=https://app.outrunner.sh` and the same Supabase project.
4. Replace the Cloudflare scheduler: stop the old Worker's scheduled trigger,
   then run `sudo systemctl enable --now outrunner-cron.timer` on the VM.
   The timer calls all six existing jobs every two minutes. One failed job
   does not prevent the others. Check `journalctl -u outrunner-cron.service`
   and the authenticated health report's heartbeat timestamps.
5. Verify public `/api/health` reports the selected SHA and repeat the user
   flows on the real hostname. Preview wildcard hosts and the old
   `outrunner.neev.ai` redirect need their own routing migration when used.

Keep the previous service available until verification passes. A rollback
must restore both hostname routing and the scheduler: stop the VM cron before
re-enabling the old one. A VM rollback to a previous release uses the same
activation command with the previous SHA. Neither kind of rollback reverses
database migrations.

The Cloudflare Worker and Durable Object can be retired after the VM has been
verified. Keeping them during the migration avoids destroying a fallback.
