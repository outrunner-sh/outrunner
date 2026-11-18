#!/usr/bin/env bash
# Run as root on the VM: unpack an exact source archive into a new release
# directory, install its helpers, build its image, and activate it. A release
# that is already built (a rollback or a repeated deploy) is activated as is.
set -euo pipefail
archive="${1:?Usage: install-release.sh ARCHIVE SHA}"
release_sha="${2:?Usage: install-release.sh ARCHIVE SHA}"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit SHA" >&2; exit 1; }
release_dir="/opt/outrunner/releases/$release_sha"
for file in runtime.env cron.env build.env; do
  [[ -s "/etc/outrunner/$file" ]] || { echo "Missing /etc/outrunner/$file; see docs/deploy-vm.md" >&2; exit 1; }
done
if [[ -e "$release_dir/.image-built" ]]; then
  echo "Release $release_sha is already built; activating it"
else
  [[ "$(readlink -f /opt/outrunner/current 2>/dev/null || true)" != "$release_dir" ]] \
    || { echo "Refusing to replace the running release" >&2; exit 1; }
  # A directory without .image-built is left from an interrupted attempt.
  rm -rf "$release_dir"
  install -d -m 0755 /opt/outrunner/releases /usr/local/lib/outrunner /usr/local/sbin "$release_dir"
  tar -xf "$archive" -C "$release_dir" --no-same-owner
  install -m 0755 "$release_dir/deploy/vm/build-release.sh" /usr/local/lib/outrunner/build-release.sh
  install -m 0755 "$release_dir/deploy/vm/activate-release.sh" /usr/local/sbin/outrunner-activate-release
  set -a
  # shellcheck disable=SC1091
  . /etc/outrunner/build.env
  set +a
  /usr/local/lib/outrunner/build-release.sh "$release_dir" "$release_sha"
fi
exec /usr/local/sbin/outrunner-activate-release "$release_sha"
