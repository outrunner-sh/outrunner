import { BOX_TOOLS } from "@/lib/runtime/box-image";

/**
 * The GitHub CLI a box installs, pinned: the agent's orientation tells it to
 * open pull requests with `gh pr create` (runtime-agent/internal/claude), and
 * the box's GH_TOKEN signs it in (lib/runtime/session-environment.ts). `gh` is
 * in none of the base images and not in Debian's repos either, so it comes
 * from its own release, a single static binary.
 */
export const GH_VERSION = BOX_TOOLS.gh;

/**
 * Install the GitHub CLI where there is none, into /usr/local/bin so `gh` is
 * on the PATH every user has. `sudo` where the installer isn't root. Grouped,
 * so it chains after `&&` as one step: a failure before it isn't hidden by the
 * install that follows succeeding.
 *
 * The release is downloaded whole before anything is unpacked, so a cut
 * connection leaves no half-written `gh` behind, and the architecture comes
 * from the box rather than being assumed (`uname -m`, not dpkg, which a
 * non-Debian image hasn't got). An architecture with no release 404s here
 * instead of installing nothing and failing later at `gh pr create`.
 */
export function ghInstallCommand({ sudo }: { sudo: boolean }): string {
  const as = sudo ? "sudo " : "";
  // gh's tarball unpacks into a directory named for the version and platform.
  const dir = `gh_${GH_VERSION}_linux_$arch`;
  return (
    `{ command -v gh >/dev/null || { ` +
    `arch=$(uname -m); case "$arch" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; esac; ` +
    `tmp=$(mktemp -d) && ` +
    `curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${dir}.tar.gz" -o "$tmp/gh.tar.gz" && ` +
    `tar -xzf "$tmp/gh.tar.gz" -C "$tmp" && ` +
    `${as}install -m 0755 "$tmp/${dir}/bin/gh" /usr/local/bin/gh && ` +
    `rm -rf "$tmp"; }; }`
  );
}
