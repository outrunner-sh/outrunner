#!/usr/bin/env bash
# Deploy an exact commit of main to the Compute Engine host over IAP SSH: the
# host builds the image and activates it, restoring the previous release if
# the new one fails its health check. Passing an already-built SHA rolls back.
#
#   GCP_PROJECT=<project-id> deploy/vm/gcp/deploy.sh [SHA]   # default: origin/main
set -euo pipefail
project="${GCP_PROJECT:?Set GCP_PROJECT to the Google Cloud project ID}"
zone="${GCP_ZONE:-asia-northeast1-b}"
instance="${GCP_INSTANCE:-outrunner-app}"

git fetch --quiet origin main
sha="$(git rev-parse --verify "${1:-origin/main}^{commit}")"
git merge-base --is-ancestor "$sha" origin/main || { echo "$sha is not on origin/main" >&2; exit 1; }

# Archive the commit, never the working tree, so local files and secrets stay here.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git archive --format=tar -o "$work/source.tar" "$sha"
git show "$sha:deploy/vm/install-release.sh" > "$work/install-release.sh"

remote="/tmp/outrunner-$sha"
ssh=(--project "$project" --zone "$zone" --tunnel-through-iap --quiet)
# Plain mkdir fails if another user already created the path in /tmp.
gcloud compute ssh "${ssh[@]}" "$instance" --command "rm -rf $remote && mkdir -m 0700 $remote"
gcloud compute scp "${ssh[@]}" "$work/source.tar" "$work/install-release.sh" "$instance:$remote/"
gcloud compute ssh "${ssh[@]}" "$instance" \
  --command "sudo bash $remote/install-release.sh $remote/source.tar $sha; status=\$?; rm -rf $remote; exit \$status"
