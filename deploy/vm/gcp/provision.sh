#!/usr/bin/env bash
# Create the Compute Engine host for the Docker Compose control plane. Safe to
# re-run: resources that already exist are kept, and only the startup script
# is refreshed. Defaults to Tokyo, next to the production Supabase database.
#
#   GCP_PROJECT=<project-id> deploy/vm/gcp/provision.sh
set -euo pipefail
project="${GCP_PROJECT:?Set GCP_PROJECT to the Google Cloud project ID}"
region="${GCP_REGION:-asia-northeast1}"
zone="${GCP_ZONE:-${region}-b}"
instance="${GCP_INSTANCE:-outrunner-app}"
machine="${GCP_MACHINE_TYPE:-e2-standard-4}"
network="$instance-net"
address="$instance-ip"
here="$(cd "$(dirname "$0")" && pwd)"

gc() { gcloud --project "$project" --quiet "$@"; }
missing() { ! gc "$@" --format='value(name)' >/dev/null 2>&1; }

gc services enable compute.googleapis.com iap.googleapis.com

# A dedicated network keeps this host's firewall separate from other work in
# the project. MTU 1500 matches Docker's bridge default; the GCP default of
# 1460 can stall large downloads made from containers.
if missing compute networks describe "$network"; then
  gc compute networks create "$network" --subnet-mode=custom --mtu=1500
fi
if missing compute networks subnets describe "$network" --region "$region"; then
  gc compute networks subnets create "$network" --network "$network" --region "$region" --range 10.60.0.0/24
fi
if missing compute firewall-rules describe "$network-web"; then
  gc compute firewall-rules create "$network-web" --network "$network" --direction INGRESS \
    --allow tcp:80,tcp:443,udp:443 --source-ranges 0.0.0.0/0 --target-tags outrunner-web
fi
# SSH only through Identity-Aware Proxy; port 22 is not open to the internet.
if missing compute firewall-rules describe "$network-iap-ssh"; then
  gc compute firewall-rules create "$network-iap-ssh" --network "$network" --direction INGRESS \
    --allow tcp:22 --source-ranges 35.235.240.0/20 --target-tags outrunner-web
fi
if missing compute addresses describe "$address" --region "$region"; then
  gc compute addresses create "$address" --region "$region"
fi

if missing compute instances describe "$instance" --zone "$zone"; then
  # No service account: the app calls no Google Cloud APIs, so a compromised
  # container gains no cloud credentials from the metadata server.
  gc compute instances create "$instance" --zone "$zone" --machine-type "$machine" \
    --subnet "$network" --address "$address" --tags outrunner-web \
    --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
    --boot-disk-size 100GB --boot-disk-type pd-balanced \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --no-service-account --no-scopes --deletion-protection \
    --metadata enable-oslogin=TRUE,block-project-ssh-keys=TRUE \
    --metadata-from-file startup-script="$here/startup.sh"
else
  gc compute instances add-metadata "$instance" --zone "$zone" \
    --metadata-from-file startup-script="$here/startup.sh"
  echo "Instance $instance already exists; refreshed its startup script (applies on next boot)"
fi

ip="$(gc compute addresses describe "$address" --region "$region" --format='value(address)')"
echo "Host $instance in $zone has static IP $ip (also its outbound IP for allowlists)."
echo "Docker installs on first boot. Check with:"
echo "  gcloud compute ssh $instance --project $project --zone $zone --tunnel-through-iap --command 'docker compose version'"
