# Google Cloud sandboxes

Run each new Outrunner cloud session on its own private Compute Engine VM in
an existing, billing-enabled Google Cloud project. Google bills compute,
50-GB persistent boot disks, and networking directly. Outrunner's cloud-hour
and concurrent-compute allowances do not meter these customer-funded VMs.

## Connect

Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), or
use [Google Cloud Shell](https://shell.cloud.google.com). Then run:

```sh
npx outrunner@latest sandbox connect gcp
```

Sign in to Outrunner and Google if asked. Choose a project, review the setup,
and approve it. Prefer a dedicated project: the provisioning identity has
project-level permissions to manage compute resources, while Outrunner checks
its own recorded VM identities before acting. You need administrator access
to configure APIs, service accounts, custom IAM roles, workload identity
pools, VPCs, subnets, routers, NAT and firewall rules. Company policies may
require your administrator to perform setup or approve external federation.
The wizard does not create a project, activate billing, or change organization
policies for you.

To choose everything explicitly:

```sh
outrunner sandbox connect gcp --project my-sandbox-project --zone us-central1-a --size small --use
```

Sizes are `small` (2 vCPU / 4 GB), `medium` (4 / 8), and `large` (8 / 16).
They use E2 custom x86 VMs. First startup installs Docker and pulls Outrunner's
pinned public box image; it can take several minutes. Unsupported zones,
quotas, IAM policies, or billing configurations fail the verification step.

`--yes` approves the displayed GCP changes without an interactive prompt.
Scripts must supply both `--project` and `--yes`. `--use` selects GCP for new
sessions only after the connection has passed its test. Otherwise the CLI
asks before switching, or leaves the choice to Settings → Sandbox. For another
Outrunner deployment, put `--url https://your-app.example` before `sandbox`.

## What setup creates

Each connection has a UUID. Its dedicated resources are named
`outrunner-<first 16 hexadecimal characters of the UUID>`:

- A service account, a custom VM lifecycle IAM role, OS Admin Login and IAP
  Tunnel Resource Accessor grants. No long-lived service-account key is made.
- A Workload Identity Federation pool and OIDC provider trusting the deployment's
  pinned public ES256 key, with audience and subject restricted to this one
  connection. The service account grants impersonation to that subject only.
- A custom-mode VPC, a regional `/24` subnet, a Cloud Router and Cloud NAT.
- One ingress rule allowing only IAP's `35.235.240.0/20` range to SSH port 22,
  restricted by the connection's VM tag. VMs have no external IP addresses and
  no attached Google service account. Runtime and preview ports stay private.

The CLI never uploads the administrator's Google access/refresh token. On each
connection, Outrunner exchanges a five-minute assertion through Google STS and
impersonates the dedicated service account for an access token lasting at most
one hour. Temporary SSH keys expire after one hour. SSH host keys are checked
against authenticated Compute Engine guest attributes. IAP carries SSH; the
server relays terminal/event WebSockets and authenticated preview traffic.

The test provisions a temporary 2-vCPU VM, uploads the real runtime-agent,
checks its health, and deletes the VM and its boot disk before reporting the
connection as ready. A failed test does not change your sandbox selection.
Google IAM and federation changes can take time to propagate; rerun the same
command if a fresh setup temporarily refuses access.

## Sessions and persistence

New sessions use the selected connection. Existing sessions keep their
original connection, project and VM identity even after another project is
selected. Stop/restore retains the persistent disk and restarts the agent;
in-memory processes do not survive a VM stop. Archive pauses the VM; deleting
the session deletes its VM and owned boot disk. Editor, desktop and live RAM
resizing are not offered on this provider. Previews use the existing Outrunner
access gate.

This initial integration does not automatically idle-pause customer-funded
sessions. Archive a session to stop its compute. Paused disks still cost money.
Cloud NAT also has charges while configured, even when all VMs are stopped.
Conversation, snapshots, media and model requests retain Outrunner's existing
data paths; selecting GCP does not mean all session data stays in that project.

## Retry and disconnect

The wizard reuses the same connection for a project/zone and can be rerun to
repair interrupted configuration or refresh pinned public keys. It does not
roll back network/IAM setup on failure. Those resources belong to you and can
incur charges before verification succeeds. Failed VM creation is tracked in a
durable ledger; the billing cron retries abandoned resources after a two-hour
grace period, deleting only recorded resources whose identities still match.
If Google access is revoked, restore it or remove remaining resources manually.

Delete the connection's sessions before using **Disconnect Google Cloud** in
Sandbox settings. Disconnect refuses while recorded VMs/disks remain. It
stops new federation for that connection and returns its default to Outrunner;
it does not remove the dedicated network, NAT, IAM role or service account.
Access tokens already issued by Google may remain valid until expiration.

To finish teardown, identify the connection's name from Google Cloud's
`outrunner-connection` VM labels or its Workload Identity pool. In the Google
Cloud console:

1. Confirm its VMs and disks are gone, including failed temporary test VMs.
2. Delete its NAT configuration, Cloud Router, `-iap` firewall rule, subnet,
   and VPC. NAT must be removed to stop its remaining networking charges.
3. Remove the dedicated service account's project IAM bindings, then delete
   its custom role, service account, and Workload Identity pool.

Only remove resources belonging to the connection you are retiring. Do not
use broad name-prefix deletion in a shared project.

## Deployment

Apply `20261104120000_gcp_sandboxes.sql` before deploying. The tables are
service-role only; CLI routes enforce user ownership, and resource intent is
recorded before Google is asked to create anything. Selection and disconnect
are serialized with resource creation in Postgres.

Set `RUNTIME_BASE_URL` to the deployment's public HTTPS origin and configure
its existing valid `CREDENTIALS_ENCRYPTION_KEY`. A domain-separated P-256 key
is derived from that root for identity signing. Replicas need the same root;
rotating it or changing the public origin requires users to rerun connect to
update their pinned trust. The discovery endpoint `/api/gcp/identity` exposes
only public keys and issuer metadata, never assertions or access tokens.

The control plane needs outbound HTTPS and WebSockets to Google APIs and
`tunnel.cloudproxy.app`. It uses the existing `ws` and `ssh2` dependencies;
gcloud is needed only on the administrator's setup machine. Leave the billing
cron enabled for failed-resource cleanup. The existing control-plane build
supplies the runtime-agent binary used in connection verification.

Cleanup claims at most ten abandoned resources per run, rotates failed attempts
behind older attempts, and waits at least five minutes before retrying a claim.
An inaccessible project cannot block cleanup for other customers.

Before release, exercise setup, a real coding turn, terminal reconnect,
preview access, stop/restore with uncommitted files, and complete deletion in
a billing-enabled GCP test project. Unit and fixture-browser tests do not
establish that a particular organization's IAM and networking policies work.
