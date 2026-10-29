/**
 * How a session's agent writes a pull request, in one place: the body's
 * structure, the rules for its evidence (screenshots and GIFs of a change a
 * person can see), and the Outrunner footer. Both places an agent is told how
 * to open one read from here:
 *
 *   - Create PR's attached `PR instructions.md` (lib/session/pr-instructions.ts);
 *   - every cloud session's standing instructions ({@link prGuide}, sent with
 *     the session to its box and appended to its orientation), so a PR the
 *     agent opens on its own (a GitHub mention, an automation, a Runner) is
 *     written the same way.
 *
 * Any server-side PR creation should build its body from these too.
 */

import type { ProviderName } from "@/lib/runtime/types";

/** What the agent has on its box to show its work. */
export type EvidenceTools = {
  /** A desktop with Chromium it can drive and record (Daytona's computer use,
   *  the `outrunner_desktop` MCP server). */
  desktop: boolean;
};

/** The tools a session on `provider` has: a desktop on Daytona's boxes (ours
 *  or the user's own account's); none on Modal's, Neev's or the user's Mac. */
export function evidenceToolsFor(provider: ProviderName | null | undefined): EvidenceTools {
  return { desktop: provider === "daytona" || provider === "user-daytona" };
}

/** Who the PR's footer credits, and where the session is. */
export type PrFooterInput = {
  /** The session's page in Outrunner. */
  sessionUrl: string;
  /** The user's name; absent, the agent uses the session's git user (which
   *  Outrunner sets to the user). */
  userName?: string;
  /** Co-Authored-By trailers for the user, if the session has any, as
   *  `Name <email>`. */
  coAuthors?: string[];
};

export const PR_TITLE_RULE =
  'Title: under 80 characters, as "Area: what changes, plainly" (e.g. "Composer drafts: kept across navigation and reload").';

/** The body's structure (#291's): every section a reader looks for, in the
 *  order they look. */
export const PR_BODY_TEMPLATE = `<1–3 sentences: what changed for the user and why; name the issue or QA ids it fixes>

## How it works
<prose and short bullets; a small table when it's clearer; ### subsections for distinct parts>

### Other changes   (only if any)

## Evidence
<one line on the setup: local app / real session / which agent, driven in Chromium on the session desktop>

**Before (<base branch>):** <steps, and what goes wrong>
![<descriptive name>](<public url>)

**After:** <same steps, and what happens now>
![<descriptive name>](<public url>)

### Verified in the browser
- [x] <each scenario actually exercised, specific: what was done and what was seen>
- [ ] <anything not exercised live, and why>

### Tests
<test files added or changed, what they cover, and the pass counts from typecheck, lint and test>

<footer>`;

/** The rules for what a body says, beyond its structure. */
export const PR_BODY_RULES = [
  "Describe the whole branch diff (`git diff origin/<base>...`), not only this session's part.",
  'Backend-only or docs changes leave out "Evidence" and "Verified in the browser", and keep "Tests".',
  "Write the body to a file and pass it with `--body-file`, so nothing in it is mangled by the shell.",
];

/** How to capture and share evidence: the format, before and after, GIFs,
 *  names and links. */
export const EVIDENCE_RULES = [
  "Format: still screenshots for static UI. A short looping GIF (3–10 s) for motion, an interaction or a multi-step flow. For a long walkthrough, the MP4 shown as a GIF that links to it. Never a grid or contact sheet of frames, never a run of separate frame screenshots.",
  "Before and after: capture both the same way, so only the change differs, and say in one line what to look for. Crop to the area that changed, the same crop for both; no tall full-page shots. Put before/after GIFs side by side in a two-column Markdown table. A new feature usually needs only the after.",
  "Recording: 16:9 (1280×720 or 1920×1080) at 30–60 fps. Start just before the interaction and stop right after.",
  "GIFs: `outrunner media gif <recording.mp4> [--start s] [--duration s] [--crop w:h:x:y]` keeps them under GitHub's 5 MB (its image proxy shows nothing larger).",
  'Upload names: descriptive and unique, e.g. "Composer draft after reload", never "screenshot": the name is the image\'s alt text.',
  "Links: upload with the `upload_media` tool or `outrunner media upload <file> --name \"…\"`, and paste the line it prints. Images get a public link that doesn't expire; videos are private unless uploaded with access public, so a PR shows a video as its GIF linking to it (`outrunner media upload` prints that line). Never commit screenshots to the repository, use local paths or expiring URLs, or rely on `gh --attach`.",
  "Public links are bearer links. Replacing one breaks every PR that shows it: never do it as routine cleanup.",
  "Screenshots taken only to check your own work stay on the box: upload only what goes in the PR.",
];

/** Running the app to verify a change in the browser, Docker included. */
export const RUN_APP_STEPS = [
  "Start the app as the repository says (README, CLAUDE.md or AGENTS.md, the project's instructions). Its dev server's port is reachable from the desktop's Chromium at http://localhost:<port>.",
  "If it needs Docker (local Supabase, Postgres, Redis), install and start it: `curl -fsSL https://get.docker.com | sudo sh`, then start the daemon in the background with `sudo dockerd > /tmp/dockerd.log 2>&1 &` (there is no systemd) and `sudo chmod 666 /var/run/docker.sock`. `supabase start` comes up in about two minutes the first time; leave out services you don't need (`-x studio,imgproxy,edge-runtime,logflare,vector,supavisor`). After the box sleeps, only `dockerd` needs starting again.",
  "If Docker or the app can't run here, use what the project documents instead (for example a hosted development Supabase whose keys are in the project's environment, or ask for them with request_secrets). If nothing works, say so under Evidence rather than skip the PR.",
];

/** The Outrunner footer: the last thing in every PR body, once. */
export function prFooter({ sessionUrl, userName, coAuthors = [] }: PrFooterInput): string {
  const name = userName?.trim() || "<the session's git user.name>";
  const lines = ["---", "", `<sub>Created by **${name}** with [Outrunner](${sessionUrl})</sub>`];
  if (coAuthors.length > 0) lines.push("", ...coAuthors.map((c) => `Co-Authored-By: ${c}`));
  return lines.join("\n");
}

/** What to do about the footer and its trailers on a body that has one. */
export const FOOTER_RULE =
  "End the body with this footer. When you edit a PR's body, keep the footer and any Co-Authored-By trailers it already has exactly as they are, wherever they came from, and never add a second footer.";

/** The steps that produce the evidence, before the PR is opened: with a
 *  desktop, in its Chromium; without one, what to write instead. */
export function evidenceSteps(tools: EvidenceTools, baseBranch: string): string[] {
  if (!tools.desktop) {
    return [
      "This session's box has no desktop to verify the change in a browser (or no way to upload what it captured). Still use the template, and don't fail the PR: under Evidence, say in one line why there is none; under \"Verified in the browser\", list what a reviewer should check, each item unchecked with the reason.",
    ];
  }
  return [
    "If the diff changes UI or behaviour a person can see, before `gh pr create`:",
    `1. Run the app (below). For **Before**, reproduce it on origin/${baseBranch} without disturbing this branch's work: a second worktree (\`git worktree add /tmp/before origin/${baseBranch}\`, run from there), or \`git stash -u\` and \`git checkout origin/${baseBranch}\`, then back and \`git stash pop\`.`,
    "2. For **After**, verify the change on this branch in Chromium on the session desktop (the `outrunner_desktop` tools: `open_browser`, `browser_snapshot`, `browser_click`, `browser_fill`, `screenshot`).",
    "3. Capture screenshots, or record with `record_start` / `record_stop` and make a GIF, following the evidence rules.",
    "4. Upload them, and write the body from the template with Evidence, \"Verified in the browser\" and Tests filled in.",
    "If the desktop or upload tools turn out not to be available in this session, don't fail the PR: say under Evidence why there is none, and leave the browser checklist unchecked with the reason.",
  ];
}

/** The evidence part of a guide: the steps, then (with a desktop) how to
 *  run the app and the rules for what is captured. */
export function evidenceSection(tools: EvidenceTools, baseBranch: string): string {
  const parts = [bullets(evidenceSteps(tools, baseBranch))];
  if (tools.desktop) parts.push(`Running the app:\n\n${bullets(RUN_APP_STEPS)}`, `Evidence rules:\n\n${bullets(EVIDENCE_RULES)}`);
  return parts.join("\n\n");
}

/** Items as Markdown bullets; numbered steps stay numbered. */
export function bullets(items: string[]): string {
  return items.map((item) => (/^\d\. /.test(item) ? item : `- ${item}`)).join("\n");
}

/** The template, its rules and the footer, for a body to be written from. */
export function templateSection(footer: PrFooterInput): string {
  return `${PR_TITLE_RULE}

Body, in this structure:

\`\`\`
${PR_BODY_TEMPLATE}
\`\`\`

${bullets(PR_BODY_RULES)}

${FOOTER_RULE}

\`\`\`
${prFooter(footer)}
\`\`\``;
}

/** What to do when a push updates a PR that is already open. */
export const UPDATE_RULE =
  "When a push updates an open PR and the new commits change what a person sees, capture new evidence and refresh the Evidence section with `gh pr edit --body-file`, keeping the footer.";

/** The whole guide, as a session's standing instructions: when it opens or
 *  updates a pull request, however it was asked to. */
export function prGuide(input: PrFooterInput & { tools: EvidenceTools; baseBranch: string }): string {
  return `# Pull requests

Whenever you open or update a pull request, write it this way.

${templateSection(input)}

## Evidence for a change a person can see

${evidenceSection(input.tools, input.baseBranch)}

${UPDATE_RULE}`;
}
