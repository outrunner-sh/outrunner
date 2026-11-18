#!/usr/bin/env bash
# Install root-owned at /usr/local/sbin/outrunner-activate-release.
#
# Switches traffic to a built release with no downtime, between two app
# slots, blue and green:
#   1. start the release in the idle slot; the live slot keeps serving
#   2. wait until the idle slot reports this exact build
#   3. point the proxy at it with a graceful reload (open connections stay)
#   4. move the scheduler to it, then stop the old slot after a drain period
# A release that fails 2 or 3 never receives traffic; the live slot is left
# as it was. Rolling back is activating an earlier, already-built release.
set -euo pipefail
release_sha="${1:?Usage: outrunner-activate-release SHA}"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit SHA" >&2; exit 1; }
root=/opt/outrunner
release_dir="$root/releases/$release_sha"
[[ "$(readlink -f "$release_dir")" = "$release_dir" ]] || { echo "Release must not resolve outside its directory" >&2; exit 1; }
for file in deploy/vm/compose.yml deploy/vm/edge.yml deploy/vm/jobs.yml deploy/vm/Caddyfile .env.build .image-built; do
  [[ -s "$release_dir/$file" ]] || { echo "Release is incomplete: $file" >&2; exit 1; }
done
grep -qx "OUTRUNNER_BUILD=$release_sha" "$release_dir/.env.build" || { echo "Build SHA does not match" >&2; exit 1; }
grep -qx "$release_sha" "$release_dir/.image-built" || { echo "Image build did not complete" >&2; exit 1; }
docker image inspect "outrunner-control-plane:$release_sha" >/dev/null

edge="$root/edge"
drain_seconds="${OUTRUNNER_DRAIN_SECONDS:-90}"
live="$(cat "$root/live-slot" 2>/dev/null || true)"
case "$live" in
  blue) next=green ;;
  green) next=blue ;;
  *) live="" next=blue ;;
esac

port_of() { if [[ "$1" = blue ]]; then echo 3001; else echo 3002; fi; }
slot() {
  local name="$1" dir="$2"; shift 2
  SLOT="$name" APP_PORT="$(port_of "$name")" \
    docker compose -p "outrunner-$name" --env-file "$dir/.env.build" -f "$dir/deploy/vm/compose.yml" "$@"
}
edge_compose() { docker compose -p outrunner-edge --env-file "$edge/.env" -f "$edge/edge.yml" "$@"; }
healthy() {
  curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$2/api/health" \
    | python3 -c 'import json,sys; h=json.load(sys.stdin); sys.exit(0 if h.get("ok") is True and h.get("build")==sys.argv[1] else 1)' "$1"
}
ready() {
  for _ in {1..45}; do
    if healthy "$1" "$2" 2>/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}
# Replace a file in one step, so the proxy never reads half of one.
replace() { python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$1" "$2"; }
write_live() {
  cat > "$edge/conf/.live.caddy" <<EOF
reverse_proxy app-$1:8080 {
	# This origin is reached directly. Remove a client-supplied Cloudflare
	# address; Caddy supplies X-Forwarded-For from the actual connection.
	header_up -CF-Connecting-IP
	# Deliver conversation streams as they arrive.
	flush_interval -1
}
EOF
  replace "$edge/conf/.live.caddy" "$edge/conf/live.caddy"
}
abandon() {
  echo "$1; live traffic was not touched" >&2
  slot "$next" "$release_dir" down || true
  exit 1
}

docker network inspect outrunner >/dev/null 2>&1 || docker network create outrunner >/dev/null
for volume in outrunner_caddy_data outrunner_caddy_config; do
  docker volume inspect "$volume" >/dev/null 2>&1 || docker volume create "$volume" >/dev/null
done
install -d -m 0755 "$edge" "$edge/conf"

echo "Starting $release_sha in slot $next"
# A slot left over from an interrupted run would hold the port.
slot "$next" "$release_dir" down >/dev/null 2>&1 || true
slot "$next" "$release_dir" up -d --no-build app || abandon "New release failed to start"
ready "$release_sha" "$(port_of "$next")" || abandon "New release failed its health check"

# The proxy's files come from the release; the proxy itself keeps running.
grep '^APP_DOMAIN=' "$release_dir/.env.build" > "$edge/.env"
cp "$release_dir/deploy/vm/edge.yml" "$edge/.edge.yml" && replace "$edge/.edge.yml" "$edge/edge.yml"
cp "$release_dir/deploy/vm/Caddyfile" "$edge/conf/.Caddyfile" && replace "$edge/conf/.Caddyfile" "$edge/conf/Caddyfile"
cp "$edge/conf/live.caddy" "$edge/conf/.live.caddy.previous" 2>/dev/null || true
write_live "$next"
if edge_compose ps -q caddy 2>/dev/null | grep -q .; then
  if ! edge_compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    if [[ -f "$edge/conf/.live.caddy.previous" ]]; then replace "$edge/conf/.live.caddy.previous" "$edge/conf/live.caddy"; fi
    abandon "The proxy refused the new configuration"
  fi
else
  # First activation on this host. A host on the earlier single-project
  # layout (project "outrunner") hands its ports over here, once, with a
  # gap of a few seconds; certificates carry over in the named volumes.
  if docker compose -p outrunner ps -q 2>/dev/null | grep -q .; then
    docker compose -p outrunner down
  fi
  edge_compose up -d caddy || abandon "The proxy failed to start"
fi

echo "$next" > "$root/.live-slot" && replace "$root/.live-slot" "$root/live-slot"
echo "$release_dir" > "$root/slot-$next"
ln -sfn "$release_dir" "$root/.current" && replace "$root/.current" "$root/current"
echo "Serving $release_sha from slot $next"

if [[ -f /etc/outrunner/cron-enabled ]]; then
  SLOT="$next" docker compose -p outrunner-jobs --env-file "$release_dir/.env.build" \
    -f "$release_dir/deploy/vm/jobs.yml" up -d --no-build cron \
    || echo "Warning: the scheduler did not restart; run activation again" >&2
fi

if [[ -n "$live" && -s "$root/slot-$live" ]]; then
  # Requests already on the old slot (streams, terminals) get time to finish.
  echo "Draining slot $live for ${drain_seconds}s"
  sleep "$drain_seconds"
  slot "$live" "$(cat "$root/slot-$live")" down || echo "Warning: slot $live did not stop" >&2
fi
