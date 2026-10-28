/**
 * What Create PR sends a session: a short prompt, and the steps to follow as an
 * attached file, `PR instructions.md`, written for the session as it is now.
 * Conductor's Create PR does the same; the agent does the work, with the
 * user's GitHub token on the box (GH_TOKEN), so its own PR skills and the
 * repository's conventions apply.
 */

export const PR_PROMPT = "Create a PR";

export const PR_INSTRUCTIONS_FILENAME = "PR instructions.md";

/** The steps, from the session's branch, its target and how many files are
 *  uncommitted: null when the count can't be read yet, and then left out. */
export function prInstructions(input: {
  branch: string;
  baseBranch: string;
  uncommitted: number | null;
  /** One repository of a session of several: its folder and `owner/name`.
   *  The PR is that repository's alone. */
  repo?: { checkout: string; fullName: string };
}): string {
  const { branch, baseBranch, uncommitted, repo } = input;
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
- Commit them. Follow any instructions the user gave you about writing commit messages.
- Push to origin (\`git push -u origin ${branch}\`).
- Run \`git diff origin/${baseBranch}...\` to review the PR diff
- If this branch already has a pull request, the push updates it: stop there and share its link.
- Use \`gh pr create --base ${baseBranch}\` to create a PR onto the target branch. Keep the title under 80 characters. Keep the description under five sentences, unless the user instructed you otherwise. Describe not just changes made in this session but ALL changes in the workspace diff.

If any of these steps fail, ask the user for help.
`;
}
