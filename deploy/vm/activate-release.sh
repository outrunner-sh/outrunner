#!/usr/bin/env bash
# Install root-owned at /usr/local/sbin/outrunner-activate-release.
set -euo pipefail
release_sha="${1:?Usage: outrunner-activate-release SHA}"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit SHA" >&2; exit 1; }
release_dir="/opt/outrunner/releases/$release_sha"
[[ "$(readlink -f "$release_dir")" = "$release_dir" ]] || { echo "Release must not resolve outside its directory" >&2; exit 1; }
for file in deploy/vm/compose.yml .env.build .image-built; do
  [[ -s "$release_dir/$file" ]] || { echo "Release is incomplete: $file" >&2; exit 1; }
done
grep -qx "OUTRUNNER_BUILD=$release_sha" "$release_dir/.env.build" || { echo "Build SHA does not match" >&2; exit 1; }
grep -qx "$release_sha" "$release_dir/.image-built" || { echo "Image build did not complete" >&2; exit 1; }
docker image inspect "outrunner-control-plane:$release_sha" >/dev/null
current=/opt/outrunner/current
previous="$(readlink -f "$current" 2>/dev/null || true)"
switch_to() {
  ln -s "$1" "/opt/outrunner/.current-$$"
  mv -Tf "/opt/outrunner/.current-$$" "$current"
}
compose() {
  local dir="$1"; shift
  docker compose --env-file "$dir/.env.build" -f "$dir/deploy/vm/compose.yml" "$@"
}
healthy() {
  curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3000/api/health \
    | python3 -c 'import json,sys; h=json.load(sys.stdin); sys.exit(0 if h.get("ok") is True and h.get("build")==sys.argv[1] else 1)' "$1"
}
ready() {
  for _ in {1..30}; do
    if healthy "$1" 2>/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}
start_release() {
  local dir="$1" sha="$2"
  compose "$dir" up -d --no-build app || return 1
  ready "$sha" || return 1
  compose "$dir" up -d --no-build caddy || return 1
  if [[ -f /etc/outrunner/cron-enabled ]]; then
    compose "$dir" --profile jobs up -d --no-build cron || return 1
  fi
}
switch_to "$release_dir"
if start_release "$release_dir" "$release_sha"; then
  echo "Serving $release_sha on the VM; verify HTTPS and user flows before changing DNS"
  exit 0
fi
echo "New release failed its health or service startup check" >&2
if [[ -n "$previous" && "$previous" != "$release_dir" && -d "$previous" ]]; then
  switch_to "$previous"
  if start_release "$previous" "$(basename "$previous")"; then
    echo "Restored previous release" >&2
  else
    echo "Previous release selected but rollback health failed; inspect docker compose logs" >&2
  fi
else
  compose "$release_dir" stop app || true
  echo "No previous VM release was available" >&2
fi
exit 1
