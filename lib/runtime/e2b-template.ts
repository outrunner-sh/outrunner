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

/** Where a template is built: an E2B's API, on a key. `user`: a user's E2B,
 *  reached through the egress proxy when self-hosted (e2b-sdk.ts). */
export type E2bBuildTarget = { apiKey: string; apiUrl?: string; user?: boolean };

/** The SDK's options for `target`. */
async function sdkOptionsFor(target: E2bBuildTarget) {
  const { e2bSdkOptions, userE2bSdkOptions } = await import("@/lib/runtime/sandbox/e2b-sdk");
  const { apiKey, apiUrl } = target;
  return target.user ? userE2bSdkOptions({ apiKey, apiUrl }) : e2bSdkOptions({ apiKey, apiUrl });
}

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
  const options = await sdkOptionsFor(target);
  const info = await Template.buildInBackground(Template().fromDockerfile(e2bDockerfile(await boxDockerfile(), boxBuildArgs(), mtu)), name, {
    ...options,
    cpuCount: size.cpu,
    memoryMB: size.memoryGb * 1024,
  });
  return { templateId: info.templateId, buildId: info.buildId, tag: BOX_IMAGE_TAG };
}

/** Where a template build is: still going, done, or failed and why. */
export type E2bBuildState = { state: "building" } | { state: "ready" } | { state: "failed"; error: string };

export async function e2bTemplateBuildStatus(target: E2bBuildTarget, build: E2bTemplateBuild): Promise<E2bBuildState> {
  const { Template } = await import("e2b");
  const status = await Template.getBuildStatus({ templateId: build.templateId, buildId: build.buildId }, await sdkOptionsFor(target));
  if (status.status === "ready") return { state: "ready" };
  if (status.status === "error") return { state: "failed", error: status.reason?.message ?? "The template build failed." };
  return { state: "building" };
}

/** Whether `name` (as E2B lists it: bare, or `<team>/<name>`) is one of
 *  user `userId`'s templates, at any image: any tag {@link userE2bTemplateName}
 *  could have written (hyphens included, e.g. a date), not only today's
 *  12-hex form, so a change to BOX_IMAGE_TAG's format doesn't leave older
 *  ones behind uncleaned. The anchors keep the 8-hex user suffix exact. */
export function isUserE2bTemplateName(name: string, userId: string): boolean {
  const bare = name.slice(name.lastIndexOf("/") + 1).replace(/:.*$/, "");
  return new RegExp(`^outrunner-box-.+-${userId.replace(/-/g, "").slice(0, 8)}$`).test(bare);
}

/**
 * Delete the user's templates other than `keep` from their E2B: the ones
 * left by earlier images (each image bump builds a new one) and failed
 * builds, whose stored artifacts they pay for. Best effort: one that can't
 * be deleted now is tried again after the next build.
 */
export async function deleteOtherUserE2bTemplates(target: E2bBuildTarget, userId: string, keep: string): Promise<void> {
  const { e2bSdkOptions } = await import("@/lib/runtime/sandbox/e2b-sdk");
  const { apiUrl, apiKey } = e2bSdkOptions(target);
  const headers = { "X-API-Key": apiKey };
  // The SDK has no call for these, so they're plain fetches: never following
  // a redirect (with the key on) anywhere, and to a host checked public.
  try {
    if (target.user && target.apiUrl) {
      const { assertPublicHost } = await import("@/lib/runtime/user-e2b-checks");
      await assertPublicHost(target.apiUrl);
    }
    const response = await fetch(`${apiUrl}/templates`, { headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`E2B answered ${response.status} listing templates`);
    const templates = (await response.json()) as Array<{ templateID: string; names?: string[]; aliases?: string[] }>;
    const old = templates.filter(
      (t) => t.templateID !== keep && [...(t.names ?? []), ...(t.aliases ?? [])].some((name) => isUserE2bTemplateName(name, userId)),
    );
    for (const t of old) {
      const deleted = await fetch(`${apiUrl}/templates/${encodeURIComponent(t.templateID)}`, {
        method: "DELETE",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (!deleted.ok && deleted.status !== 404) console.warn(`Could not delete old E2B template ${t.templateID}: ${deleted.status}`);
    }
  } catch (error) {
    console.warn(`Could not clean up user ${userId}'s old E2B templates`, error);
  }
}
