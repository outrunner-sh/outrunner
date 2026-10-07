#!/usr/bin/env bash
# Build the runtime-agent for macOS and stage it as the desktop app's sidecar
# (tauri.conf.json bundle.externalBin). Local sessions run this copy on the
# user's own Mac; Runtime Computers use the linux build from build-agent.sh.
#
# Tauri resolves a sidecar by target triple, so the binary is written under all
# three names it may ask for: each architecture for a plain `tauri build` or
# `tauri dev`, and the lipo'd universal one for `--target universal-apple-darwin`
# (how the team DMG is built). Output is gitignored.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$repo_root/runtime-desktop/src-tauri/binaries"
mkdir -p "$out_dir"

cd "$repo_root/runtime-agent"
for arch in arm64 amd64; do
  GOOS=darwin GOARCH="$arch" CGO_ENABLED=0 go build \
    -trimpath -ldflags="-s -w" \
    -o "$out_dir/runtime-agent-$arch" ./cmd/runtime-agent
done

cp "$out_dir/runtime-agent-arm64" "$out_dir/runtime-agent-aarch64-apple-darwin"
cp "$out_dir/runtime-agent-amd64" "$out_dir/runtime-agent-x86_64-apple-darwin"
lipo -create -output "$out_dir/runtime-agent-universal-apple-darwin" \
  "$out_dir/runtime-agent-arm64" "$out_dir/runtime-agent-amd64"
rm "$out_dir/runtime-agent-arm64" "$out_dir/runtime-agent-amd64"

echo "built desktop agent sidecars in $out_dir"
