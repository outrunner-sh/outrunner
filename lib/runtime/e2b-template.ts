import { createHash } from "node:crypto";

import { BOX_IMAGE_TAG } from "@/lib/runtime/box-image";

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
export function e2bDockerfile(
  dockerfile: string,
  args: Record<string, string>,
  mtu: number | null = null,
  desktopScript: string | null = null,
): string {
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

  // Any form Docker expands, `${NAME:-default}` and `${NAME:+x}` included.
  const left = [...declared].filter((name) => new RegExp(`\\$\\{?${name}\\b`).test(text));
  if (left.length > 0) throw new Error(`box/Dockerfile still refers to ${left.join(", ")} after substitution`);
  if (/^RUN test -n/m.test(text)) throw new Error("box/Dockerfile's build-arg guard changed; update e2bDockerfile");

  if (mtu !== null) text = text.replace(/^(FROM [^\n]+\n)/m, `$1USER root\nRUN ip link set eth0 mtu ${mtu}\n`);
  return desktopScript === null ? text : `${text.replace(/\n*$/, "\n")}${e2bDesktopLayer(desktopScript)}`;
}

/** What a desktop needs on an E2B box, which has none of its own: a virtual
 *  display, Xfce, x11vnc and noVNC's proxy (box/e2b-desktop.sh drives them). */
const DESKTOP_PACKAGES = "xvfb xfce4 xfce4-terminal dbus-x11 x11vnc novnc websockify";

/** The template's layer on top of box/Dockerfile for the Desktop tab:
 *  the desktop's packages and `outrunner-desktop`, box/e2b-desktop.sh. Ends
 *  as the box user, as box/Dockerfile does. */
export function e2bDesktopLayer(desktopScript: string): string {
  return [
    "USER root",
    `RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${DESKTOP_PACKAGES} && rm -rf /var/lib/apt/lists/*`,
    // Base64: the script's quotes and newlines never meet the Dockerfile's.
    `RUN echo ${Buffer.from(desktopScript).toString("base64")} | base64 -d > /usr/local/bin/outrunner-desktop && chmod 0755 /usr/local/bin/outrunner-desktop`,
    "USER runtime",
    "",
  ].join("\n");
}

/** The tag an E2B template of box/Dockerfile at `boxTag`, with `desktopScript`
 *  layered on, goes by: so a change to either builds a new one. */
export function e2bTemplateTag(boxTag: string, desktopScript: string): string {
  return createHash("sha256").update(boxTag).update("\0").update(e2bDesktopLayer(desktopScript)).digest("hex").slice(0, 12);
}

/** {@link e2bTemplateTag} of BOX_IMAGE_TAG and box/e2b-desktop.sh as
 *  committed. Written out, so the app reads neither to know it; its test
 *  fails when they part. */
export const E2B_TEMPLATE_TAG = "84d43be950d3";

/** The template's name in a user's own E2B: the template tag it's built at
 *  (as `E2B_TEMPLATE_TAG` is now), and the user, in case E2B's names are shared
 *  across accounts. */
export function userE2bTemplateName(userId: string, tag: string): string {
  return `outrunner-box-${tag}-${userId.replace(/-/g, "").slice(0, 8)}`;
}

/** box/Dockerfile and box/e2b-desktop.sh as this server has them: in the
 *  repository and the app's image alike, at the working directory's root.
 *  Refused when they aren't the ones the tags name, rather than build tools
 *  the agent wasn't built for. */
export async function boxSources(cwd = process.cwd()): Promise<{ dockerfile: string; desktopScript: string }> {
  const [{ readFile }, path, { boxImageTag }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("@/lib/runtime/box-image"),
  ]);
  const [dockerfile, desktopScript] = await Promise.all([
    readFile(path.join(cwd, "box", "Dockerfile"), "utf8"),
    readFile(path.join(cwd, "box", "e2b-desktop.sh"), "utf8"),
  ]);
  if (boxImageTag(dockerfile) !== BOX_IMAGE_TAG) {
    throw new Error("box/Dockerfile or BOX_TOOLS changed: update BOX_IMAGE_TAG in lib/runtime/box-image.ts first");
  }
  if (e2bTemplateTag(BOX_IMAGE_TAG, desktopScript) !== E2B_TEMPLATE_TAG) {
    throw new Error("box/e2b-desktop.sh or BOX_IMAGE_TAG changed: update E2B_TEMPLATE_TAG in lib/runtime/e2b-template.ts");
  }
  return { dockerfile, desktopScript };
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
  const [{ Template }, { boxBuildArgs }, { boxSize }] = await Promise.all([
    import("e2b"),
    import("@/lib/runtime/box-image"),
    import("@/lib/runtime/box-sizes"),
  ]);
  const size = boxSize("small");
  const options = await sdkOptionsFor(target);
  const { dockerfile, desktopScript } = await boxSources();
  const info = await Template.buildInBackground(Template().fromDockerfile(e2bDockerfile(dockerfile, boxBuildArgs(), mtu, desktopScript)), name, {
    ...options,
    cpuCount: size.cpu,
    memoryMB: size.memoryGb * 1024,
  });
  return { templateId: info.templateId, buildId: info.buildId, tag: E2B_TEMPLATE_TAG };
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
  const { e2bSdkOptions, proxiedFetch, userE2bProxy } = await import("@/lib/runtime/sandbox/e2b-sdk");
  const { apiUrl, apiKey } = e2bSdkOptions(target);
  const headers = { "X-API-Key": apiKey };
  // The SDK has no call for these, so they're our own fetches: never
  // following a redirect (with the key on), and to a user's self-hosted E2B
  // through the egress proxy, like the SDK's calls: only their API's host,
  // resolved public-only as it connects.
  try {
    const proxy = target.user ? await userE2bProxy({ apiUrl: target.apiUrl }) : undefined;
    const fetch = proxy ? await proxiedFetch(proxy) : globalThis.fetch;
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
