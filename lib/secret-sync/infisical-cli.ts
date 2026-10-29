/**
 * The `infisical` CLI on a session's box, for a project linked to Infisical
 * (docs/secret-sync.md). It isn't in the box image: a 66 MB download every
 * box would carry for the few projects that use it. So a linked session's
 * start hook installs it first, where it's missing: once a box, in the
 * background beside the session (the agent doesn't wait for start hooks),
 * pinned, and checked against its release's checksum before anything is
 * installed. The session's environment signs it in (infisicalCliEnv).
 *
 * A failed install says so in the session's setup log and goes on to the
 * project's own start hook: the secrets are in the environment either way.
 */

/** The release installed, and its tarballs' sha256 from its checksums.txt. */
export const INFISICAL_CLI = {
  version: "0.44.10",
  sha256: {
    amd64: "3800bded850e00ce1c402a48f081c4b210cfbdf4f9a4a794cf159a2fef0a8efa",
    arm64: "97d49c74b16eb9d7d492e4825a941b0386d00de0bcdf0e4e023687cc754bd5b2",
  },
} as const;

type Release = { version: string; sha256: { amd64: string; arm64: string } };

/**
 * A shell step installing the CLI into `dir` (/usr/local/bin, on every
 * user's PATH) where `infisical` isn't on the PATH already: as the hook's
 * user where it can write there, else with sudo (without a prompt: the box
 * user's sudo needs no password, and a box whose sudo does gets the message
 * instead of a hung hook). Always succeeds; a failure is a line on stderr.
 */
export function infisicalInstallStep(release: Release = INFISICAL_CLI, dir = "/usr/local/bin"): string {
  const base = `https://github.com/Infisical/cli/releases/download/v${release.version}`;
  // One && chain, not `set -e`: a shell ignores -e left of an ||, so a
  // checksum that didn't match would go on to install.
  return [
    "# Outrunner: the Infisical CLI, for this project's Infisical link.",
    "if ! command -v infisical >/dev/null 2>&1; then (",
    `  case "$(uname -m)" in`,
    `    x86_64|amd64) arch=amd64 sum=${release.sha256.amd64} ;;`,
    `    aarch64|arm64) arch=arm64 sum=${release.sha256.arm64} ;;`,
    "    *) arch= ;;",
    "  esac",
    "  tmp=$(mktemp -d)",
    `  if [ -n "$arch" ] &&`,
    `    curl -fsSL "${base}/cli_${release.version}_linux_$arch.tar.gz" -o "$tmp/cli.tar.gz" &&`,
    `    echo "$sum  $tmp/cli.tar.gz" | sha256sum -c - >/dev/null &&`,
    `    tar -xzf "$tmp/cli.tar.gz" -C "$tmp" infisical &&`,
    `    { install -m 0755 "$tmp/infisical" "${dir}/infisical" 2>/dev/null ||`,
    `      sudo -n install -m 0755 "$tmp/infisical" "${dir}/infisical"; }`,
    "  then :",
    "  else echo \"Outrunner couldn't install the Infisical CLI; the project's Infisical secrets are in the environment all the same.\" >&2",
    "  fi",
    `  rm -rf "$tmp"`,
    ") fi",
  ].join("\n");
}

/** A start hook with the CLI's install first, then the project's own. */
export function withInfisicalCli(startHook: string | null | undefined): string {
  return startHook ? `${infisicalInstallStep()}\n\n${startHook}` : `${infisicalInstallStep()}\n`;
}
