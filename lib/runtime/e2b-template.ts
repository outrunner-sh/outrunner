/**
 * box/Dockerfile as E2B's template builder takes it. E2B builds from a
 * Dockerfile's text but has no build args, so the pinned versions
 * (boxBuildArgs, from BOX_TOOLS) are written into it, and the `ARG` lines and
 * the guard that refuses a build without them are dropped: the same image,
 * with nothing left to pass in.
 */

/** The older guard box/Dockerfile opened with, refusing a build without its
 *  args; it runs on two lines. A guard in another form (a `for` over the
 *  args) is kept: with the values written in, it passes. */
const ARG_GUARD = /^RUN test -n "\$NODE_MAJOR"[^\n]*\\\n[^\n]*\n/m;

/**
 * `dockerfile` with every `${NAME}` and `$NAME` of `args` replaced by its value, its
 * `# syntax`, `ARG` lines and arg guard removed, and, with `mtu`, the build
 * VM's interface set to it before anything is downloaded (where the host's
 * network carries smaller packets, large downloads otherwise break off).
 * Throws when an arg is left unset, rather than build an image without it.
 */
export function e2bDockerfile(dockerfile: string, args: Record<string, string>, mtu: number | null = null): string {
  let text = dockerfile.replace(ARG_GUARD, "");
  // Every ARG is dropped, so every one, with a default or not, must be given
  // a value here: one left would expand to nothing in E2B's build, silently.
  const declared = new Set(Object.keys(args));
  text = text
    .split("\n")
    .filter((line) => {
      const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (arg) declared.add(arg[1]);
      return !line.startsWith("# syntax=") && !arg;
    })
    .join("\n");
  // Both `${NAME}` and `$NAME`, as Docker expands an ARG in either form.
  for (const [name, value] of Object.entries(args)) {
    text = text.replace(new RegExp(`\\$(\\{${name}\\}|${name}(?![A-Za-z0-9_]))`, "g"), () => value);
  }

  const left = [...declared].filter((name) => new RegExp(`\\$(\\{${name}\\}|${name}\\b)`).test(text));
  if (left.length > 0) throw new Error(`box/Dockerfile still refers to ${left.join(", ")} after substitution`);
  if (/^RUN test -n/m.test(text)) throw new Error("box/Dockerfile's build-arg guard changed; update e2bDockerfile");

  if (mtu !== null) text = text.replace(/^(FROM [^\n]+\n)/m, `$1USER root\nRUN ip link set eth0 mtu ${mtu}\n`);
  return text;
}
