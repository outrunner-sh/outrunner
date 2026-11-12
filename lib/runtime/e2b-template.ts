/**
 * box/Dockerfile as E2B's template builder takes it. E2B builds from a
 * Dockerfile's text but has no build args, so the pinned versions
 * (boxBuildArgs, from BOX_TOOLS) are written into it, and the `ARG` lines and
 * the guard that refuses a build without them are dropped: the same image,
 * with nothing left to pass in.
 */

/** The guard box/Dockerfile opens with, refusing a build without its args;
 *  it runs on two lines. */
const ARG_GUARD = /^RUN test -n "\$NODE_MAJOR"[^\n]*\\\n[^\n]*\n/m;

/**
 * `dockerfile` with every `${NAME}` of `args` replaced by its value, its
 * `# syntax`, `ARG` lines and arg guard removed, and, with `mtu`, the build
 * VM's interface set to it before anything is downloaded (where the host's
 * network carries smaller packets, large downloads otherwise break off).
 * Throws when an arg is left unset, rather than build an image without it.
 */
export function e2bDockerfile(dockerfile: string, args: Record<string, string>, mtu: number | null = null): string {
  let text = dockerfile.replace(ARG_GUARD, "");
  text = text
    .split("\n")
    .filter((line) => !line.startsWith("# syntax=") && !line.startsWith("ARG "))
    .join("\n");
  for (const [name, value] of Object.entries(args)) text = text.replaceAll(`\${${name}}`, value);

  const left = Object.keys(args).filter((name) => text.includes(`$${name}`) || text.includes(`\${${name}}`));
  if (left.length > 0) throw new Error(`box/Dockerfile still refers to ${left.join(", ")} after substitution`);
  if (/^RUN test -n/m.test(text)) throw new Error("box/Dockerfile's build-arg guard changed; update e2bDockerfile");

  if (mtu !== null) text = text.replace(/^(FROM [^\n]+\n)/m, `$1USER root\nRUN ip link set eth0 mtu ${mtu}\n`);
  return text;
}
