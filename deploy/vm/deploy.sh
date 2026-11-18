#!/usr/bin/env bash
# Deploy an exact commit of main to the VM: the host builds the image and
# activates it, restoring the previous release if the new one fails its
# health check. Passing an already-built SHA rolls back.
#
# Plain SSH (any host):
#   OUTRUNNER_VM_SSH=deploy@host OUTRUNNER_VM_SSH_PORT=22 deploy/vm/deploy.sh [SHA]
#   (optional OUTRUNNER_VM_SSH_KEY=path; the host key must already be known)
# Compute Engine over IAP:
#   GCP_PROJECT=<project-id> deploy/vm/deploy.sh [SHA]   (optional GCP_ZONE, GCP_INSTANCE)
#
# SHA defaults to origin/main. OUTRUNNER_ALLOW_UNMERGED=1 also accepts a
# commit pushed to any branch on origin, to try a pull request before merge.
set -euo pipefail

if [[ -n "${OUTRUNNER_VM_SSH:-}" ]]; then
  port="${OUTRUNNER_VM_SSH_PORT:-22}"
  opts=(-o BatchMode=yes -o StrictHostKeyChecking=yes)
  [[ -z "${OUTRUNNER_VM_SSH_KEY:-}" ]] || opts+=(-i "$OUTRUNNER_VM_SSH_KEY" -o IdentitiesOnly=yes)
  run() { ssh "${opts[@]}" -p "$port" "$OUTRUNNER_VM_SSH" "$1"; }
  copy() { local dest="$1"; shift; scp "${opts[@]}" -P "$port" "$@" "$OUTRUNNER_VM_SSH:$dest"; }
elif [[ -n "${GCP_PROJECT:-}" ]]; then
  gcp=(--project "$GCP_PROJECT" --zone "${GCP_ZONE:-asia-northeast1-b}" --tunnel-through-iap --quiet)
  instance="${GCP_INSTANCE:-outrunner-app}"
  run() { gcloud compute ssh "${gcp[@]}" "$instance" --command "$1"; }
  copy() { local dest="$1"; shift; gcloud compute scp "${gcp[@]}" "$@" "$instance:$dest"; }
else
  echo "Set OUTRUNNER_VM_SSH (user@host) or GCP_PROJECT to choose the host" >&2
  exit 1
fi

git fetch --quiet origin
sha="$(git rev-parse --verify "${1:-origin/main}^{commit}")"
if ! git merge-base --is-ancestor "$sha" origin/main; then
  [[ "${OUTRUNNER_ALLOW_UNMERGED:-}" = 1 ]] || { echo "$sha is not on origin/main (OUTRUNNER_ALLOW_UNMERGED=1 accepts a pushed branch)" >&2; exit 1; }
  git branch -r --contains "$sha" | grep -q '^ *origin/' || { echo "$sha is not pushed to origin" >&2; exit 1; }
  echo "Deploying $sha, which is not on main" >&2
fi

# Archive the commit, never the working tree, so local files and secrets stay here.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git archive --format=tar -o "$work/source.tar" "$sha"
git show "$sha:deploy/vm/install-release.sh" > "$work/install-release.sh"

remote="/tmp/outrunner-$sha"
# Plain mkdir fails if another user already created the path in /tmp.
run "rm -rf $remote && mkdir -m 0700 $remote"
copy "$remote/" "$work/source.tar" "$work/install-release.sh"
run "sudo bash $remote/install-release.sh $remote/source.tar $sha; status=\$?; rm -rf $remote; exit \$status"
