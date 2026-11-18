#!/usr/bin/env bash
# Let GitHub Actions deploy to the Compute Engine host without a stored key:
# Workload Identity Federation trusts only this repository's `production`
# environment (which allows main only), and the deployer service account can
# do nothing but reach this one instance over IAP SSH with sudo. Safe to re-run.
#
#   GCP_PROJECT=<project-id> deploy/vm/gcp/github-deployer.sh
set -euo pipefail
project="${GCP_PROJECT:?Set GCP_PROJECT to the Google Cloud project ID}"
zone="${GCP_ZONE:-asia-northeast1-b}"
instance="${GCP_INSTANCE:-outrunner-app}"
repo="${GITHUB_REPOSITORY:-outrunner-sh/outrunner}"
# The numeric id survives a rename or transfer; a name could be re-registered.
repo_id="$(gh api "repos/$repo" --jq .id)"
pool=github
provider=outrunner
account="outrunner-deployer@$project.iam.gserviceaccount.com"

gc() { gcloud --project "$project" --quiet "$@"; }
missing() { ! gc "$@" --format='value(name)' >/dev/null 2>&1; }

gc services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com oslogin.googleapis.com
number="$(gc projects describe "$project" --format='value(projectNumber)')"

if missing iam workload-identity-pools describe "$pool" --location global; then
  gc iam workload-identity-pools create "$pool" --location global --display-name "GitHub Actions"
fi
if missing iam workload-identity-pools providers describe "$provider" --workload-identity-pool "$pool" --location global; then
  gc iam workload-identity-pools providers create-oidc "$provider" --workload-identity-pool "$pool" --location global \
    --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping 'google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.environment=assertion.environment' \
    --attribute-condition "assertion.repository_id == '$repo_id' && assertion.environment == 'production'"
fi
if missing iam service-accounts describe "$account"; then
  gc iam service-accounts create outrunner-deployer --display-name "Outrunner GitHub deployer"
fi
gc iam service-accounts add-iam-policy-binding "$account" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/$pool/attribute.repository_id/$repo_id" >/dev/null
# SSH with sudo on this instance only; IAP tunnelling and reading the instance.
gc compute instances add-iam-policy-binding "$instance" --zone "$zone" --role roles/compute.osAdminLogin \
  --member "serviceAccount:$account" >/dev/null
gc compute instances add-iam-policy-binding "$instance" --zone "$zone" --role roles/compute.viewer \
  --member "serviceAccount:$account" >/dev/null
gc projects add-iam-policy-binding "$project" --role roles/iap.tunnelResourceAccessor \
  --member "serviceAccount:$account" --condition None >/dev/null
# `gcloud compute ssh` reads the project (OS Login, metadata) before connecting;
# a custom role grants that one read instead of project-wide compute.viewer.
if missing iam roles describe outrunnerDeployerProjectRead; then
  gc iam roles create outrunnerDeployerProjectRead --project "$project" \
    --title "Outrunner deployer: read project" --permissions compute.projects.get --stage GA
fi
gc projects add-iam-policy-binding "$project" --role "projects/$project/roles/outrunnerDeployerProjectRead" \
  --member "serviceAccount:$account" --condition None >/dev/null

echo "Set these repository variables (Settings -> Secrets and variables -> Actions -> Variables):"
echo "  GCP_PROJECT=$project"
echo "  GCP_WORKLOAD_IDENTITY_PROVIDER=projects/$number/locations/global/workloadIdentityPools/$pool/providers/$provider"
echo "  GCP_DEPLOY_SERVICE_ACCOUNT=$account"
echo "  PRODUCTION_TARGET=vm"
