/**
 * The API's answer when a call names a repository its org has no project for
 * (by `owner/name` or `repository`), the same wherever it's named. A team org
 * with no GitHub connected has none at all: that's said, with where an admin
 * connects it, rather than "add it" alone (lib/api/no-repository.deps.ts wires
 * it to the org).
 */

import type { ApiCallerKind } from "@/lib/api/auth";
import { apiError } from "@/lib/api/errors";

export type NoRepositoryInput = {
  fullName: string;
  /** The org the call acts in; null when it couldn't be read. */
  org: { id: string; name: string; personal: boolean } | null;
  orgId: string;
  callerKind: ApiCallerKind;
  /** Whether the org has a GitHub App installation; null when unknown. */
  githubConnected: boolean | null;
  /** The app's own address, for the link. */
  base: string;
};

export function noRepositoryAnswer(input: NoRepositoryInput): Response {
  const { fullName, org } = input;
  const where = org ? `the org ${org.name} (${org.id})` : `the org ${input.orgId}`;
  if (org && !org.personal && input.githubConnected === false) {
    const settingsUrl = new URL("/settings/org/github", input.base).toString();
    return apiError(
      404,
      `No repository ${fullName} in ${where}: it has no GitHub connected yet, so it has no repositories. An admin connects GitHub at ${settingsUrl}, and its repositories are added to its projects.`,
      { settingsUrl },
    );
  }
  const which = input.callerKind === "org_key"
    ? "An org key acts in its own org alone."
    : "A personal key or the CLI acts in your personal org unless the call names another (`?org=`, or the `Outrunner-Org` header).";
  return apiError(
    404,
    `No repository ${fullName} in ${where} that you can see: add it to Outrunner (Environments → Pick repositories), or check the org. ${which} GET /projects lists what this key sees.`,
  );
}
