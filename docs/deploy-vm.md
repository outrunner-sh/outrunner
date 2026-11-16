# Deploy Outrunner with Docker Compose on a VM

Run the existing control-plane image on your own Linux VM. Docker Compose
starts the app, Caddy HTTPS proxy, and background scheduler. Cloudflare
Workers, the Containers API, and Durable Objects are not needed to run this
host. Cloudflare may continue to serve DNS.

Keep the existing Supabase project and sandbox provider. Only the control
plane moves; user data and existing Daytona/Neev computers stay in place.

## Google Cloud (Tokyo)

Production Supabase is in Tokyo, so the host runs in `asia-northeast1`; every
request makes several database round trips, and a same-region host keeps each
one to about a millisecond. [`deploy/vm/gcp`](../deploy/vm/gcp) creates and
updates it with `gcloud`:

```sh
gcloud auth login
export GCP_PROJECT=<project-id>   # optional: GCP_ZONE, GCP_INSTANCE, GCP_MACHINE_TYPE
deploy/vm/gcp/provision.sh
```

`provision.sh` is safe to re-run. It creates an `e2-standard-4` Ubuntu 24.04
VM (4 vCPU, 16 GB, 100 GB disk) in `asia-northeast1-b` with a static IP, on a
dedicated network whose firewall opens only 80/443 publicly and SSH through
Identity-Aware Proxy. The VM has no service account, deletion protection is
on, and its startup script installs Docker and Compose. The static IP is also
the host's outbound address if a provider allowlists callers.

Write the three configuration files described below locally, outside the
repository, and move them into place over IAP SSH:

```sh
ssh_flags="--project $GCP_PROJECT --zone asia-northeast1-b --tunnel-through-iap"
gcloud compute scp $ssh_flags runtime.env cron.env build.env outrunner-app:
gcloud compute ssh $ssh_flags outrunner-app --command \
  'sudo install -m 0600 -o root -g root runtime.env cron.env build.env /etc/outrunner/ && shred -u runtime.env cron.env build.env'
```

Then deploy:

```sh
deploy/vm/gcp/deploy.sh            # origin/main
deploy/vm/gcp/deploy.sh <sha>      # a specific commit of main, or a rollback
OUTRUNNER_ALLOW_UNMERGED=1 deploy/vm/gcp/deploy.sh <sha>   # a pushed PR commit, for testing
```

`deploy.sh` archives the commit, copies it over IAP SSH, and runs
`install-release.sh` on the host, as described in the following sections.

### Automatic deploys

With the repository variable `PRODUCTION_TARGET=vm`, every merge to `main`
deploys to the VM once CI passes: the `deploy-vm` job in
[`deploy.yml`](../.github/workflows/deploy.yml) runs `deploy.sh` for that
commit, then checks that `https://app.outrunner.sh/api/health` serves it and
reports a usable configuration. Rollback is the same workflow run by hand with
an earlier `ref`. The job signs in with Workload Identity Federation, so no
Google key is stored in GitHub; set it up once with:

```sh
GCP_PROJECT=<project-id> deploy/vm/gcp/github-deployer.sh
```

It trusts only this repository's `production` environment (main only), and
the deployer service account can only SSH with sudo into this one VM over
IAP. Set the four repository variables it prints.

## Prepare another host

Use an x86-64 Linux VM with Docker Engine, Compose **2.30 or later**, Python 3,
and curl. An on-host build should have 4 vCPUs, 8 GB RAM, and 40 GB disk. Node,
pnpm, and Go run inside the image build. Install Docker from its official
repository and enable its service at boot.

Inspect existing workloads first. Preserve SSH and unrelated services; Caddy
needs ports 80/443. The app is published only on `127.0.0.1:3000`, and cron has
no published ports. Caddy removes client-supplied Cloudflare address headers,
supplies forwarding headers, and supports streaming and WebSocket upgrades.

```sh
sudo install -d -m 0755 /opt/outrunner/releases /usr/local/lib/outrunner
sudo install -d -m 0700 /etc/outrunner
sudo systemctl enable --now docker
```

Each release installs its own build and activation helpers.

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
copying a working directory containing local secrets, and copy it with the
installer from the same commit:

```sh
sha=$(git rev-parse origin/main)
git archive --format=tar "$sha" > /tmp/outrunner-source.tar
git show "$sha:deploy/vm/install-release.sh" > /tmp/install-release.sh
# copy both files to the host, then on the host:
sudo bash install-release.sh outrunner-source.tar "$sha"
```

The installer refuses to run until all three files under `/etc/outrunner`
exist. It extracts the archive into a **new** directory
`/opt/outrunner/releases/$sha`, installs that release's helpers, builds with
the public settings from `build.env`, and activates. A release that is already
built is activated without rebuilding, which is how rollback works.

The image builds the Go agent, verifies the published CLI, and builds Next.
Its tag is `outrunner-control-plane:<sha>`, with `OUTRUNNER_BUILD` baked in.
Release metadata `.env.build` contains only public values; runtime secrets
stay under `/etc/outrunner`. Apply pending migrations before installing;
older installations should check the [migration recovery notes](../supabase/README.md).

Activation updates `/opt/outrunner/current`, starts the app, verifies local
health and the exact build SHA, then starts Caddy. Failed activation restores
the previous VM image and configuration when available. Previous source
folders and image tags must remain available for rollback. Caddy persists
certificates in named volumes; keep those volumes during updates. Each
release keeps its image; remove old release directories and their
`outrunner-control-plane:<sha>` images (and run `docker builder prune`) when
the disk fills, keeping the last few for rollback.

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
