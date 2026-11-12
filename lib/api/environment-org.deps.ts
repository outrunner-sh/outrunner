import { projectOutsideOrg } from "@/lib/api/environment-org";
import { apiRoute, type ApiContext } from "@/lib/api/handler";
import { environmentOrgId } from "@/lib/db/environments";

/**
 * apiRoute for an endpoint under /environments/{id}: `work` runs only for a
 * project of the call's org (lib/api/environment-org.ts), else the 404.
 */
export function projectApiRoute(request: Request, id: string, work: (api: ApiContext) => Promise<Response>): Promise<Response> {
  return apiRoute(request, async (api) => {
    const refused = await projectOutsideOrg(api, id, async (userId, environmentId) => {
      const orgId = await environmentOrgId(userId, environmentId);
      return orgId ? { orgId } : null;
    });
    return refused ?? work(api);
  });
}
