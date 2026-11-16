# Deploy Outrunner with Docker Compose on a VM

Run the existing control-plane image on your own Linux VM. Docker Compose
starts the app, Caddy HTTPS proxy, and background scheduler. Cloudflare
Workers, the Containers API, and Durable Objects are not needed to run this
host. Cloudflare may continue to serve DNS.

Keep the existing Supabase project and sandbox provider. Only the control
plane moves; user data and existing Daytona/Neev computers stay in place.

## Prepare the host

Use an x86-64 Linux VM with Docker Engine, Compose **2.30 or later**, Python 3,
and curl. An on-host build should have 4 vCPUs, 8 GB RAM, and 40 GB disk. Node,
pnpm, and Go run inside the image build. Install Docker from its official
repository and enable its service at boot.

Inspect existing workloads first. Preserve SSH and unrelated services; Caddy
needs ports 80/443. The app is published only on `127.0.0.1:3000`, and cron has
no published ports. Caddy removes client-supplied Cloudflare address headers,
supplies forwarding headers, and supports streaming and WebSocket upgrades.

Install the helpers from a reviewed checkout:

```sh
sudo install -d -m 0755 /opt/outrunner/releases /usr/local/lib/outrunner
sudo install -d -m 0700 /etc/outrunner
sudo install -m 0755 deploy/vm/build-release.sh /usr/local/lib/outrunner/build-release.sh
sudo install -m 0755 deploy/vm/activate-release.sh /usr/local/sbin/outrunner-activate-release
sudo systemctl enable --now docker
```

## Preserve production configuration

Create `/etc/outrunner/runtime.env`, owned by root with mode `0600`, outside
source archives and the image build context. Compose's `raw` environment-file
format reads `NAME=value` literally: omit surrounding quotes and encode a
multiline GitHub private key with literal `\n` sequences. The app converts
those sequences back to newlines.

Copy the current production settings, including the same Supabase project
and keys, provider keys, GitHub App credentials, billing/Stripe settings,
OpenRouter, cron secret, email, access restrictions, and integrations in use.
**Preserve the exact existing `CREDENTIALS_ENCRYPTION_KEY`** so saved user
credentials stay readable. Set the production origin to
`RUNTIME_BASE_URL=https://app.outrunner.sh`. See [`.env.example`](../.env.example)
for the supported variables. Do not generate replacement keys for a hosting
migration.

Create `/etc/outrunner/cron.env`, also root-owned `0600`, with only the same
`BILLING_CRON_SECRET`. The scheduler receives no unrelated app credentials.

Create `/etc/outrunner/build.env` with these public build values:

```dotenv
APP_DOMAIN=app.outrunner.sh
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-public-key
NEXT_PUBLIC_CODEX_CLI_VERSION=the-supported-version
```

Use the existing production values. The hosted CLI pin is recorded in
`cloudflare/wrangler.jsonc`; reading it requires no Cloudflare API call.

## Build and activate an exact release

Select a commit on `main` that passed CI. Archive that commit rather than
copying a working directory containing local secrets:

```sh
sha=$(git rev-parse origin/main)
git archive --format=tar "$sha" > /tmp/outrunner-source.tar
```

Transfer the archive over SSH, create a **new** directory
`/opt/outrunner/releases/$sha`, and extract it there. Do not overwrite a
running or already-built release. Export only the public build settings:

```sh
set -a
. /etc/outrunner/build.env
set +a
/usr/local/lib/outrunner/build-release.sh "/opt/outrunner/releases/$sha" "$sha"
```

The image builds the Go agent, verifies the published CLI, and builds Next.
Its tag is `outrunner-control-plane:<sha>`, with `OUTRUNNER_BUILD` baked in.
Release metadata `.env.build` contains only public values; runtime secrets
stay under `/etc/outrunner`. Apply pending migrations before activation;
older installations should check the [migration recovery notes](../supabase/README.md).

```sh
sudo /usr/local/sbin/outrunner-activate-release "$sha"
```

Activation updates `/opt/outrunner/current`, starts the app, verifies local
health and the exact build SHA, then starts Caddy. Failed activation restores
the previous VM image and configuration when available. Previous source
folders and image tags must remain available for rollback. Caddy persists
certificates in named volumes; keep those volumes during updates.

Inspect the selected release:

```sh
cd /opt/outrunner/current
docker compose --env-file .env.build -f deploy/vm/compose.yml logs --tail 100 app
```

## Cut over from Cloudflare Containers

1. Test the VM candidate before changing production routing: local and
   authenticated health, Caddy TLS, sign-in/callbacks, existing/new sessions,
   conversation streams, and terminal WebSockets. A temporary test hostname
   needs its own DNS record, `APP_DOMAIN`, matching app origin, and Supabase
   redirect allowlist entry. Preserve production callback settings.
2. Merge the accompanying workflow guard and set the repository Actions
   variable **`PRODUCTION_TARGET=vm`**. The legacy Cloudflare workflow then
   stands down instead of reclaiming the hostname on a later merge. This
   initial setup uses the build/activate flow above for future VM updates;
   it does not install automatic VM deployment from GitHub Actions.
3. Save the Worker custom-domain binding and DNS record for `app.outrunner.sh`.
   Remove that Worker binding and point DNS at the VM. Updating an A record
   alone does not bypass a Worker custom domain. Use DNS-only routing initially
   so Caddy can obtain its certificate directly. Restore the production app
   origin if a temporary hostname was used, retaining the same database.
4. Stop the old Worker's scheduled trigger, then start the VM scheduler:

   ```sh
   cd /opt/outrunner/current
   docker compose --env-file .env.build -f deploy/vm/compose.yml --profile jobs up -d cron
   sudo touch /etc/outrunner/cron-enabled
   ```

   It calls all six jobs every two minutes with independent timeouts and no
   credential forwarding through redirects. The marker preserves this choice
   on later activations. Check cron logs and authenticated health heartbeats.
5. Confirm public `/api/health` reports the chosen SHA and repeat the user
   flows. Preview wildcard hosts and the old `outrunner.neev.ai` redirect need
   separate routing migration when used. The supplied Caddyfile serves only
   `APP_DOMAIN`; see [Previews](previews.md).

Keep the old service available until verification passes. A hosting rollback
must stop VM cron and remove `/etc/outrunner/cron-enabled` before re-enabling
the old scheduler and restoring hostname routing. Image rollback uses the
activation helper with the previous SHA. Neither kind reverses migrations.
Retire the old Worker and Durable Object after verifying the VM.
