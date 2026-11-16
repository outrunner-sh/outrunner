#!/usr/bin/env bash
# Run as the unprivileged deployment user. The source is an archive of an
# exact Git commit, not a checkout containing runtime secrets.
set -euo pipefail

release_dir="${1:?Usage: build-release.sh /opt/outrunner/releases/SHA SHA}"
release_sha="${2:?An exact Git commit SHA is required}"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit SHA" >&2; exit 1; }
[[ "$release_dir" = "/opt/outrunner/releases/$release_sha" ]] || { echo "Unexpected release directory" >&2; exit 1; }
[[ -d "$release_dir" && ! -L "$release_dir" ]] || { echo "Release source directory is missing or is a symlink" >&2; exit 1; }
[[ "$(readlink -f /opt/outrunner/current 2>/dev/null || true)" != "$release_dir" ]] || { echo "Refusing to rebuild the running release" >&2; exit 1; }
[[ ! -e "$release_dir/.env.build" ]] || { echo "Release is already built; activate it or use a new directory" >&2; exit 1; }

for name in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_CODEX_CLI_VERSION; do
  [[ -n "${!name:-}" ]] || { echo "$name is required at build time" >&2; exit 1; }
done

cd "$release_dir"
node -e 'if (Number(process.versions.node.split(".")[0]) !== 22 || Number(process.versions.node.split(".")[1]) < 18) process.exit(1)' \
  || { echo "Use Node 22.18 or later in the Node 22 series" >&2; exit 1; }
command -v pnpm >/dev/null
command -v go >/dev/null
export NEXT_TELEMETRY_DISABLED=1
pnpm install --frozen-lockfile
bash scripts/build-agent.sh "$release_dir/bin/runtime-agent-linux-amd64"
node scripts/verify-codex-cli.mjs "$NEXT_PUBLIC_CODEX_CLI_VERSION"
pnpm build
mkdir -p .next/cache
printf 'OUTRUNNER_BUILD=%s\n' "$release_sha" > .env.build
echo "Built $release_sha; the running release has not changed"
