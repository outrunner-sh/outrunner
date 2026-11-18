#!/usr/bin/env bash
# Build an immutable Docker image from an exact source archive on the VM.
set -euo pipefail
release_dir="${1:?Usage: build-release.sh /opt/outrunner/releases/SHA SHA}"
release_sha="${2:?An exact Git commit SHA is required}"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit SHA" >&2; exit 1; }
[[ "$release_dir" = "/opt/outrunner/releases/$release_sha" ]] || { echo "Unexpected release directory" >&2; exit 1; }
[[ -d "$release_dir" && ! -L "$release_dir" ]] || { echo "Release source is missing or is a symlink" >&2; exit 1; }
[[ "$(readlink -f /opt/outrunner/current 2>/dev/null || true)" != "$release_dir" ]] || { echo "Refusing to rebuild the running release" >&2; exit 1; }
[[ ! -e "$release_dir/.image-built" ]] || { echo "Release is already built" >&2; exit 1; }
for name in APP_DOMAIN NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_CODEX_CLI_VERSION; do
  [[ -n "${!name:-}" && "${!name}" != *$'\n'* ]] || { echo "$name is required as a single-line build value" >&2; exit 1; }
done
docker compose version >/dev/null
export OUTRUNNER_BUILD="$release_sha"
# Public values only; runtime secrets stay in /etc/outrunner/runtime.env.
{
  for name in OUTRUNNER_BUILD APP_DOMAIN NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_CODEX_CLI_VERSION; do
    printf '%s=%s\n' "$name" "${!name}"
  done
} > "$release_dir/.env.build"
docker compose --env-file "$release_dir/.env.build" -f "$release_dir/deploy/vm/compose.yml" build app
printf '%s\n' "$release_sha" > "$release_dir/.image-built"
echo "Built $release_sha; the running release has not changed"
