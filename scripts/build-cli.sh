#!/usr/bin/env bash
# Build the `outrunner` CLI (runtime-agent/cmd/outrunner) for each platform and
# stage the npm packages in .context/cli-npm/: the `outrunner` launcher
# (cli-npm/) and one `outrunner-<os>-<cpu>` package per platform, which npm
# installs only where its `os` and `cpu` match. Windows is the exception:
# `outrunner-windows-<cpu>`, as npm's spam check refused outrunner-win32-x64.
# Publish the platform packages first, then the launcher:
#
#   scripts/build-cli.sh 0.1.0
#   for dir in .context/cli-npm/outrunner-*/; do npm publish "$dir"; done
#   npm publish .context/cli-npm/outrunner
set -euo pipefail

version="${1:?usage: scripts/build-cli.sh <version>}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$repo_root/.context/cli-npm"
rm -rf "$out"
mkdir -p "$out"

# npm's names for a platform, then Go's.
targets="darwin:arm64:darwin:arm64 darwin:x64:darwin:amd64 linux:arm64:linux:arm64 linux:x64:linux:amd64 win32:x64:windows:amd64"

cd "$repo_root/runtime-agent"
for target in $targets; do
  IFS=: read -r os cpu goos goarch <<<"$target"
  pkg="outrunner-$os-$cpu"
  # npm's spam check refused outrunner-win32-x64: Windows's is outrunner-windows-x64. Keep
  # in step with PACKAGES in cli-npm/bin/outrunner.mjs.
  [ "$os" = win32 ] && pkg="outrunner-windows-$cpu"
  exe="outrunner"; [ "$os" = win32 ] && exe="outrunner.exe"
  mkdir -p "$out/$pkg/bin"
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X runtime-agent/internal/cli.Version=$version" \
    -o "$out/$pkg/bin/$exe" ./cmd/outrunner
  cp "$repo_root/LICENSE" "$out/$pkg/LICENSE"
  cat "$repo_root/licenses/go-runtime.txt" "$repo_root/licenses/creack-pty.txt" "$repo_root/licenses/gorilla-websocket.txt" > "$out/$pkg/THIRD_PARTY_NOTICES.txt"
  cat >"$out/$pkg/package.json" <<JSON
{
  "name": "$pkg",
  "version": "$version",
  "description": "The outrunner CLI for $os $cpu. Install outrunner, not this.",
  "license": "MIT",
  "os": ["$os"],
  "cpu": ["$cpu"],
  "files": ["bin/$exe", "THIRD_PARTY_NOTICES.txt"]
}
JSON
done

mkdir -p "$out/outrunner"
cp -R "$repo_root/cli-npm/." "$out/outrunner/"
cp "$repo_root/LICENSE" "$out/outrunner/LICENSE"
node -e '
  const fs = require("fs"), file = process.argv[1], version = process.argv[2];
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.version = version;
  for (const name of Object.keys(pkg.optionalDependencies)) pkg.optionalDependencies[name] = version;
  // Every platform package staged must be one the launcher depends on, and
  // the other way round: a mismatch otherwise shows only when a user runs it, as
  // "is not installed".
  const staged = fs.readdirSync(process.argv[3]).filter((d) => d.startsWith("outrunner-"));
  const listed = Object.keys(pkg.optionalDependencies);
  const missing = staged.filter((d) => !listed.includes(d)).concat(listed.filter((d) => !staged.includes(d)));
  if (missing.length) throw new Error("cli-npm/package.json optionalDependencies and the staged packages differ: " + missing.join(", "));
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$out/outrunner/package.json" "$version" "$out"

echo "staged outrunner $version in $out"
