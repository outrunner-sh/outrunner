import { addRegistryApi, listRegistriesApi } from "@/lib/api/environment-skills";
import { projectOutsideOrg } from "@/lib/api/environment-org.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

// As the project page's route: each registry is read from GitHub.
export const maxDuration = 60;

/** A project's skill registries, with the skills in each. (docs/api.md) */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, async (api) => (await projectOutsideOrg(api, id)) ?? listRegistriesApi(api, id));
}

/** Add a GitHub repository as a project's skill registry. (docs/api.md) */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, async (api) => (await projectOutsideOrg(api, id)) ?? addRegistryApi(api, id));
}
