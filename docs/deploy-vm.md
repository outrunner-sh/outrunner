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
deploy/vm/deploy.sh            # origin/main
deploy/vm/deploy.sh <sha>      # a specific commit of main, or a rollback
OUTRUNNER_ALLOW_UNMERGED=1 deploy/vm/deploy.sh <sha>   # a pushed PR commit, for testing
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

## Another host over SSH

Any Ubuntu host reachable over SSH works the same way. Prepare it once as
root, then give deploys their own user and key:

```sh
ssh -p <port> root@<host> 'bash -s' < deploy/vm/setup-host.sh
# on the host: a `deploy` user whose authorized_keys holds a key made for
# GitHub Actions, with passwordless sudo (the installer runs as root)
```

Copy the three configuration files below to `/etc/outrunner` (root, `0600`).
Deploy with the same script:

```sh
OUTRUNNER_VM_SSH=deploy@<host> OUTRUNNER_VM_SSH_PORT=<port> deploy/vm/deploy.sh
```

For automatic deploys, set the repository variables `VM_SSH_HOST`,
`VM_SSH_PORT`, `VM_SSH_USER` and `VM_SSH_KNOWN_HOSTS` (the host's key line
from `ssh-keyscan`, checked against the host's own fingerprint) and the
secret `VM_SSH_KEY`. With `VM_SSH_HOST` set, `deploy-vm` uses SSH instead
of Google Cloud.

Keep the host near the database: every request makes several database
round trips, so a host in another region adds that distance to each one.

## Prepare another host by hand

Use an x86-64 Linux VM with Docker Engine, Compose **2.30 or later**, Python 3,
and curl. An on-host build should have 4 vCPUs, 8 GB RAM, and 40 GB disk. Node,
pnpm, and Go run inside the image build. Install Docker from its official
repository and enable its service at boot.

Inspect existing workloads first. Preserve SSH and unrelated services; Caddy
needs ports 80/443. The two app slots are published only on `127.0.0.1:3001`
and `127.0.0.1:3002`, and cron has no published ports. Caddy removes client-supplied Cloudflare address headers,
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

Create `/etc/outrunner/build.env` with the domain the proxy serves:

```dotenv
APP_DOMAIN=app.outrunner.sh
```

The image's public build values (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_CODEX_CLI_VERSION`) live in
`cloudflare/wrangler.jsonc`'s `image_vars`, read by CI
(`scripts/image-build-values.mjs`). Only a release built on the VM (below)
needs them in `build.env` too.

## How a merge reaches production

1. **Every pull request's CI builds the production image** of the tree it tests
   (its merge with `main`) on Blacksmith's cached builder, and pushes it to
   `ghcr.io/outrunner-sh/outrunner/control-plane:tree-<tree>` (`ci.yml`,
   Image). It checks the image starts and reports that tree. A tree already
   built is left alone.
2. **A merge to `main` deploys at once when it was tested as is**: when a pull
   request merged in it ran green with the merge's very tree, which is the case
   when the pull request was up to date with `main` (**Update branch** before
   merging). `deploy/plan.mjs` decides. A merge whose pull request was behind
   `main` waits for `main`'s CI, which builds its image, about five minutes
   more. A run whose commit is no longer `main`'s head stands down: the head's
   run ships it.
3. **The VM pulls the image** (`deploy.sh` with `OUTRUNNER_IMAGE`) using the
   deploy run's own token, sent on stdin and kept nowhere. It tags it
   `outrunner-control-plane:<sha>` and activates it (below). Only the commit's
   `deploy/vm/` files are sent.

From merge to live is about two minutes for an up-to-date pull request. Each
image carries its tree (`OUTRUNNER_TREE`), and activation requires the new
slot's `/api/health` to report both the commit and the tree, so the code
running is the code that was tested.

The repository variable `VM_BUILD_ON_VM=true` switches back to building on the
VM, the old way (below), for every deploy. A rollback by hand to a commit from
before images is built on the VM too, unless the VM still has it.

## Build and activate an exact release on the VM

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

Activation switches with no downtime between two app slots, blue and green
(compose projects `outrunner-blue` and `outrunner-green`):

1. The release starts in the idle slot while the live slot keeps serving.
2. The idle slot must report this exact build on its local port.
3. Caddy (project `outrunner-edge`, files in `/opt/outrunner/edge`) is pointed
   at it by rewriting `conf/live.caddy` and reloading. A reload keeps every
   open connection; deploys never restart Caddy.
4. The scheduler (project `outrunner-jobs`) moves to the new slot, and the old
   slot stops after a 90-second drain (`OUTRUNNER_DRAIN_SECONDS`), from a
   detached timer (`outrunner-activate-release --drain`, logged to
   `/opt/outrunner/drain.log`): the deploy is done at the switch. The timer
   stops the slot only if it is still idle and still that release by then.

A release that fails to start, reports another build, or whose configuration
Caddy refuses never receives traffic: the live slot is left as it was.
Rolling back is activating an earlier, already-built release. The live slot is
recorded in `/opt/outrunner/live-slot`. The first activation on a host from the
earlier single-project layout hands over ports 80/443 once, with a gap of a
few seconds. Caddy persists certificates in the named volumes
`outrunner_caddy_data` and `outrunner_caddy_config`; keep them during updates. After
each activation, `prune-releases.sh` keeps both slots' releases and the
newest others, five in all (`OUTRUNNER_KEEP_RELEASES`), with their images,
and removes the rest, untagged images, and build cache older than a day.

Inspect the selected release:

```sh
docker compose -p "outrunner-$(cat /opt/outrunner/live-slot)" logs --tail 100 app
docker compose -p outrunner-edge logs --tail 50 caddy
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
   sudo touch /etc/outrunner/cron-enabled
   sudo /usr/local/sbin/outrunner-activate-release "$(basename "$(readlink /opt/outrunner/current)")"
   ```

   It calls all six jobs every two minutes with independent timeouts and no
   credential forwarding through redirects. The marker preserves this choice
   on later activations, which start the scheduler against the live slot. Check cron logs and authenticated health heartbeats.
5. Confirm public `/api/health` reports the chosen SHA and repeat the user
   flows. Preview wildcard hosts and the old `outrunner.neev.ai` redirect need
   separate routing migration when used. The supplied Caddyfile serves only
   `APP_DOMAIN`; see [Previews](previews.md).

Keep the old service available until verification passes. A hosting rollback
must stop VM cron and remove `/etc/outrunner/cron-enabled` before re-enabling
the old scheduler and restoring hostname routing. Image rollback uses the
activation helper with the previous SHA. Neither kind reverses migrations.
Retire the old Worker and Durable Object after verifying the VM.
