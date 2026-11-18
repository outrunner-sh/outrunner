#!/usr/bin/env bash
# Install root-owned at /usr/local/lib/outrunner/prune-releases.sh; run after
# each activation. Keeps the newest releases (by their last activation) and
# their images for an instant rollback, and always both slots' (the live one,
# and the one draining or kept for a switch back); removes the rest, and the
# build cache and untagged images a release leaves behind.
set -euo pipefail
root=/opt/outrunner
keep="${OUTRUNNER_KEEP_RELEASES:-5}"
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || { echo "OUTRUNNER_KEEP_RELEASES must be a positive number" >&2; exit 1; }

# Both slots' releases, always; then the newest others, up to $keep in all.
kept=" "
for name in blue green; do
  if [[ -s "$root/slot-$name" ]]; then kept+="$(basename "$(cat "$root/slot-$name")") "; fi
done
others=$(( keep - $(wc -w <<<"$kept") ))
while IFS= read -r dir; do
  sha="$(basename "$dir")"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || continue
  case "$kept" in *" $sha "*) continue ;; esac
  if (( others > 0 )); then
    others=$((others - 1))
    continue
  fi
  echo "Removing release $sha"
  docker image rm "outrunner-control-plane:$sha" >/dev/null 2>&1 || true
  rm -rf "$root/releases/$sha"
done < <(ls -1dt "$root"/releases/*/ 2>/dev/null | sed 's:/$::')

# Images no release names (a pulled image's registry tag is removed once
# it's tagged as its release) and what an on-VM build left in the cache.
docker image prune -f >/dev/null
docker builder prune -f --filter until=24h >/dev/null 2>&1 || true
