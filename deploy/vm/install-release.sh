#!/usr/bin/env bash
# Run as root on the VM: make a release of an exact commit and activate it.
#
#   install-release.sh --pull IMAGE TREE ARCHIVE SHA   (the image from CI)
#   install-release.sh ARCHIVE SHA                     (built here, the old way)
#
# --pull: ARCHIVE is the commit's deploy/vm/ files. The image CI built for the
# commit's tree is pulled from the registry, signed in with a token read from
# stdin that is kept nowhere, and tagged as the release; the release records
# the tree, which activation checks the new slot reports. Otherwise ARCHIVE
# is the whole source, and the image is built here (build-release.sh).
#
# A release that is already made (a rollback or a repeated deploy) is
# activated as is. After an activation, old releases are pruned.
set -euo pipefail
root=/opt/outrunner
pull_image="" pull_tree=""
if [[ "${1:-}" = --pull ]]; then
  pull_image="${2:?Usage: install-release.sh --pull IMAGE TREE ARCHIVE SHA}"
  pull_tree="${3:?Usage: install-release.sh --pull IMAGE TREE ARCHIVE SHA}"
  shift 3
  [[ "$pull_image" =~ ^ghcr\.io/[a-z0-9._/-]+:tree-[0-9a-f]{40}$ ]] || { echo "Invalid image" >&2; exit 1; }
  [[ "$pull_tree" =~ ^[0-9a-f]{40}$ && "$pull_image" = *":tree-$pull_tree" ]] || { echo "Image and tree don't match" >&2; exit 1; }
fi
archive="${1:?Usage: install-release.sh ARCHIVE SHA}"
release_sha="${2:?Usage: install-release.sh ARCHIVE SHA}"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit SHA" >&2; exit 1; }
release_dir="$root/releases/$release_sha"
for file in runtime.env cron.env build.env; do
  [[ -s "/etc/outrunner/$file" ]] || { echo "Missing /etc/outrunner/$file; see docs/deploy-vm.md" >&2; exit 1; }
done

install_helpers() {
  install -m 0755 "$release_dir/deploy/vm/build-release.sh" /usr/local/lib/outrunner/build-release.sh
  install -m 0755 "$release_dir/deploy/vm/prune-releases.sh" /usr/local/lib/outrunner/prune-releases.sh
  install -m 0755 "$release_dir/deploy/vm/activate-release.sh" /usr/local/sbin/outrunner-activate-release
}

if [[ -e "$release_dir/.image-built" ]]; then
  echo "Release $release_sha is already built; activating it"
else
  [[ "$(readlink -f "$root/current" 2>/dev/null || true)" != "$release_dir" ]] \
    || { echo "Refusing to replace the running release" >&2; exit 1; }
  # A directory without .image-built is left from an interrupted attempt.
  rm -rf "$release_dir"
  install -d -m 0755 "$root/releases" /usr/local/lib/outrunner /usr/local/sbin "$release_dir"
  tar -xf "$archive" -C "$release_dir" --no-same-owner
  install_helpers
  if [[ -n "$pull_image" ]]; then
    # The token is the deploy run's, read once, and the sign-in lives in a
    # folder of its own for the pull alone.
    IFS= read -r token || true
    [[ -n "${token:-}" ]] || { echo "No registry token on stdin" >&2; exit 1; }
    docker_config="$(mktemp -d)"
    trap 'rm -rf "$docker_config"' EXIT
    printf '%s' "$token" | DOCKER_CONFIG="$docker_config" docker login ghcr.io --username outrunner-deploy --password-stdin >/dev/null
    unset token
    DOCKER_CONFIG="$docker_config" docker pull --quiet "$pull_image"
    rm -rf "$docker_config"
    docker tag "$pull_image" "outrunner-control-plane:$release_sha"
    # The release's tag is the one kept; the registry's goes.
    docker image rm "$pull_image" >/dev/null
    domain="$(sed -n 's/^APP_DOMAIN=//p' /etc/outrunner/build.env)"
    [[ -n "$domain" && "$domain" != *$'\n'* ]] || { echo "APP_DOMAIN is missing from /etc/outrunner/build.env" >&2; exit 1; }
    printf 'OUTRUNNER_BUILD=%s\nOUTRUNNER_TREE=%s\nAPP_DOMAIN=%s\n' "$release_sha" "$pull_tree" "$domain" > "$release_dir/.env.build"
    printf '%s\n' "$release_sha" > "$release_dir/.image-built"
    echo "Pulled $pull_image as $release_sha; the running release has not changed"
  else
    set -a
    # shellcheck disable=SC1091
    . /etc/outrunner/build.env
    set +a
    /usr/local/lib/outrunner/build-release.sh "$release_dir" "$release_sha"
  fi
fi
/usr/local/sbin/outrunner-activate-release "$release_sha"
/usr/local/lib/outrunner/prune-releases.sh || echo "Warning: old releases were not pruned" >&2
