/** noRepositoryAnswer (lib/api/no-repository.ts) for a call, with its org
 *  and whether that org has GitHub connected read from the database. */

import type { ApiContext } from "@/lib/api/handler";
import { noRepositoryAnswer } from "@/lib/api/no-repository";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { getOrg } from "@/lib/db/orgs";

export async function noRepository(context: ApiContext, fullName: string): Promise<Response> {
  const orgId = context.caller.orgId;
  const [org, installations] = await Promise.all([
    getOrg(orgId).catch(() => null),
    listOrgInstallations(orgId).catch(() => null),
  ]);
  return noRepositoryAnswer({
    fullName,
    org,
    orgId,
    callerKind: context.caller.kind,
    githubConnected: installations ? installations.length > 0 : null,
    base: context.base,
  });
}
