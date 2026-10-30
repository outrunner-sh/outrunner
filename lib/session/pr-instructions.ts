/**
 * What Create PR sends a session: a short prompt, and the steps to follow as an
 * attached file, `PR instructions.md`, written for the session as it is now.
 * Conductor's Create PR does the same; the agent does the work, with the
 * user's GitHub token on the box (GH_TOKEN), so its own PR skills and the
 * repository's conventions apply.
 *
 * The body's structure, the evidence rules and the footer are
 * lib/session/pr-template.ts's, shared with every session's standing
 * instructions: a change a person can see is run, checked in the browser,
 * captured and uploaded before the PR is opened, on a box with a desktop.
 */

import {
  commitAttributionSection,
  type EvidenceTools,
  evidenceSection,
  type PrFooterInput,
  templateSection,
  UPDATE_RULE,
} from "@/lib/session/pr-template";

export const PR_PROMPT = "Create a PR";

export const PR_INSTRUCTIONS_FILENAME = "PR instructions.md";

/** The footer details the Environment panel sends with its explicit Create PR
 *  request. Keep the trusted identity here so those one-off instructions and
 *  the standing session guide enforce the same commit attribution. */
export function prInstructionFooter(sessionUrl: string, coAuthor?: string | null): PrFooterInput {
  return {
    sessionUrl,
    ...(coAuthor ? { coAuthors: [coAuthor] } : {}),
  };
}

/** The steps, from the session's branch, its target and how many files are
 *  uncommitted: null when the count can't be read yet, and then left out. */
export function prInstructions(input: {
  branch: string;
  baseBranch: string;
  uncommitted: number | null;
  /** One repository of a session of several: its folder and `owner/name`.
   *  The PR is that repository's alone. */
  repo?: { checkout: string; fullName: string };
  /** What the box has to show the change (pr-template.ts evidenceToolsFor). */
  tools: EvidenceTools;
  /** Who the footer credits, and the session's page. */
  footer: PrFooterInput;
}): string {
  const { branch, baseBranch, uncommitted, repo, tools, footer } = input;
  const state = [
    repo
      ? `This PR is for ${repo.fullName} only, the repository in the \`${repo.checkout}/\` folder. Run every step below in that folder (\`cd ${repo.checkout}\`), and leave the other repositories' folders alone.`
      : null,
    uncommitted === null
      ? null
      : uncommitted === 0
        ? "There are no uncommitted changes."
        : `There ${uncommitted === 1 ? "is 1 uncommitted change" : `are ${uncommitted} uncommitted changes`}.`,
    `The current branch is ${branch}.`,
    `The target branch is origin/${baseBranch}.`,
  ].filter((line) => line !== null);

  return `The user likes the current state of the code.

${state.join("\n")}

The user requested a PR.

Follow these steps to create a PR:

- If you have any skills related to creating PRs, invoke them now. Instructions there should take precedence over these instructions.
- Run \`git diff\` to review uncommitted changes
- Commit them. Follow any instructions the user gave you about writing commit messages and the attribution rules below.
- Run \`git diff origin/${baseBranch}...\` to review the whole PR diff, and decide whether it changes UI or behaviour a person can see.
- If it does, produce the evidence now, before pushing (below). Backend-only and docs changes skip this.
- Push to origin (\`git push -u origin ${branch}\`).
- If this branch already has a pull request, the push updates it. ${UPDATE_RULE} Then share its link and evidence in your final chat reply.
- Otherwise write the body from the template below to a file and run \`gh pr create --base ${baseBranch} --title "…" --body-file <file>\` to create a PR onto the target branch, unless the user instructed you otherwise. Describe not just changes made in this session but ALL changes in the workspace diff.

If any of these steps fail, ask the user for help.

${commitAttributionSection(footer.coAuthors)}

## Evidence

${evidenceSection(tools, baseBranch)}

## The pull request

${templateSection(footer)}
`;
}
