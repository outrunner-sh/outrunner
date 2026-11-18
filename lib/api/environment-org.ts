/**
 * Whether a project (an environment) named in a public API path is in the
 * org the call is in (lib/api/auth.ts). The project page's own routes, which
 * the API's project endpoints call as the key's maker, check what the maker
 * may do in any of their orgs; a key is for one org, so a project of
 * another is no project of the key's. The lookup, and the apiRoute every
 * such endpoint answers through, are environment-org.deps.ts's.
 */

import { apiError } from "@/lib/api/errors";
import type { ApiContext } from "@/lib/api/handler";
import { isUuid } from "@/lib/ids";

/** The project's org as its maker may see it, or null. */
export type FindProject = (userId: string, id: string) => Promise<{ orgId: string } | null>;

/** Null when the project is the call's org's (or `id` isn't an id at all,
 *  which the endpoint answers itself); else the 404 to answer. */
export async function projectOutsideOrg(context: Pick<ApiContext, "caller">, id: string, find: FindProject): Promise<Response | null> {
  if (!isUuid(id)) return null;
  const environment = await find(context.caller.userId, id);
  if (environment && environment.orgId === context.caller.orgId) return null;
  return apiError(404, "No environment by that id that you can see.");
}
