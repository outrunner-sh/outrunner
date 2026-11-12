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
  for (const [name, value] of Object.entries(args)) text = text.replaceAll(`\${${name}}`, value);

  const left = [...declared].filter((name) => new RegExp(`\\$(\\{${name}\\}|${name}\\b)`).test(text));
  if (left.length > 0) throw new Error(`box/Dockerfile still refers to ${left.join(", ")} after substitution`);
  if (/^RUN test -n/m.test(text)) throw new Error("box/Dockerfile's build-arg guard changed; update e2bDockerfile");

  if (mtu !== null) text = text.replace(/^(FROM [^\n]+\n)/m, `$1USER root\nRUN ip link set eth0 mtu ${mtu}\n`);
  return text;
}

/** The template's name in a user's own E2B: the image tag it's built at
 *  (as `BOX_IMAGE_TAG` is now), and the user, in case E2B's names are shared
 *  across accounts. */
export function userE2bTemplateName(userId: string, tag: string): string {
  return `outrunner-box-${tag}-${userId.replace(/-/g, "").slice(0, 8)}`;
}

/** box/Dockerfile as this server has it: in the repository and the app's
 *  image alike, at the working directory's root. Refused when it isn't the
 *  one BOX_IMAGE_TAG names, rather than build tools the agent wasn't built for. */
export async function boxDockerfile(cwd = process.cwd()): Promise<string> {
  const [{ readFile }, path, { BOX_IMAGE_TAG, boxImageTag }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("@/lib/runtime/box-image"),
  ]);
  const text = await readFile(path.join(cwd, "box", "Dockerfile"), "utf8");
  if (boxImageTag(text) !== BOX_IMAGE_TAG) {
    throw new Error("box/Dockerfile or BOX_TOOLS changed: update BOX_IMAGE_TAG in lib/runtime/box-image.ts first");
  }
  return text;
}

/** Where a template is built: an E2B's API, on a key. */
export type E2bBuildTarget = { apiKey: string; apiUrl?: string };

/** A template build under way, to ask after with {@link e2bTemplateBuildStatus}. */
export type E2bTemplateBuild = { templateId: string; buildId: string; tag: string };

/**
 * Start building Outrunner's box template (box/Dockerfile at the BOX_TOOLS
 * pins, Small-sized) on `target`, named `name`, and return without waiting:
 * a build takes minutes. With `mtu`, the build VM's interface is set to it
 * first (see e2bDockerfile).
 */
export async function startE2bTemplateBuild(
  target: E2bBuildTarget,
  name: string,
  mtu: number | null = null,
): Promise<E2bTemplateBuild> {
  const [{ Template }, { BOX_IMAGE_TAG, boxBuildArgs }, { boxSize }] = await Promise.all([
    import("e2b"),
    import("@/lib/runtime/box-image"),
    import("@/lib/runtime/box-sizes"),
  ]);
  const size = boxSize("small");
  const { e2bSdkOptions } = await import("@/lib/runtime/sandbox/e2b-sdk");
  const info = await Template.buildInBackground(Template().fromDockerfile(e2bDockerfile(await boxDockerfile(), boxBuildArgs(), mtu)), name, {
    ...e2bSdkOptions(target),
    cpuCount: size.cpu,
    memoryMB: size.memoryGb * 1024,
  });
  return { templateId: info.templateId, buildId: info.buildId, tag: BOX_IMAGE_TAG };
}

/** Where a template build is: still going, done, or failed and why. */
export type E2bBuildState = { state: "building" } | { state: "ready" } | { state: "failed"; error: string };

export async function e2bTemplateBuildStatus(target: E2bBuildTarget, build: E2bTemplateBuild): Promise<E2bBuildState> {
  const [{ Template }, { e2bSdkOptions }] = await Promise.all([import("e2b"), import("@/lib/runtime/sandbox/e2b-sdk")]);
  const status = await Template.getBuildStatus({ templateId: build.templateId, buildId: build.buildId }, e2bSdkOptions(target));
  if (status.status === "ready") return { state: "ready" };
  if (status.status === "error") return { state: "failed", error: status.reason?.message ?? "The template build failed." };
  return { state: "building" };
}
