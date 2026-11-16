#!/usr/bin/env bash
# Install root-owned at /usr/local/sbin/outrunner-activate-release. This never
# executes a shell script supplied by a release as root.
set -euo pipefail

release_sha="${1:?Usage: outrunner-activate-release SHA}"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit SHA" >&2; exit 1; }
release_dir="/opt/outrunner/releases/$release_sha"
[[ "$(readlink -f "$release_dir")" = "$release_dir" ]] || { echo "Release must not resolve outside its directory" >&2; exit 1; }
for file in .next/BUILD_ID bin/runtime-agent-linux-amd64 server.ts .env.build; do
  [[ -s "$release_dir/$file" ]] || { echo "Release is incomplete: $file" >&2; exit 1; }
done
grep -qx "OUTRUNNER_BUILD=$release_sha" "$release_dir/.env.build" || { echo "Build SHA does not match" >&2; exit 1; }

current=/opt/outrunner/current
previous="$(readlink -f "$current" 2>/dev/null || true)"
switch_to() {
  ln -s "$1" "/opt/outrunner/.current-$$"
  mv -Tf "/opt/outrunner/.current-$$" "$current"
}
healthy() {
  curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3000/api/health \
    | /usr/bin/node -e 'let text=""; process.stdin.on("data", c => text+=c); process.stdin.on("end", () => { try { const h=JSON.parse(text); process.exit(h.ok === true && h.build === process.argv[1] ? 0 : 1); } catch { process.exit(1); } });' "$1"
}

switch_to "$release_dir"
if systemctl restart outrunner.service; then
  for attempt in {1..30}; do
    if healthy "$release_sha" 2>/dev/null; then
      echo "Serving $release_sha on the VM; verify HTTPS and user flows before changing DNS"
      exit 0
    fi
    sleep 2
  done
fi

echo "New release failed its health check" >&2
if [[ -n "$previous" && "$previous" != "$release_dir" && -d "$previous" ]]; then
  switch_to "$previous"
  systemctl restart outrunner.service
  echo "Restored previous release; inspect journalctl -u outrunner.service" >&2
else
  systemctl stop outrunner.service
  echo "No previous VM release was available" >&2
fi
exit 1
