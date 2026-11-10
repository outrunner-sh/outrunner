import { addRegistryApi, listRegistriesApi } from "@/lib/api/environment-skills";
import { projectApiRoute } from "@/lib/api/environment-org.deps";

type RouteContext = { params: Promise<{ id: string }> };

// As the project page's route: each registry is read from GitHub.
export const maxDuration = 60;

/** A project's skill registries, with the skills in each. (docs/api.md) */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return projectApiRoute(request, id, (api) => listRegistriesApi(api, id));
}

/** Add a GitHub repository as a project's skill registry. (docs/api.md) */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return projectApiRoute(request, id, (api) => addRegistryApi(api, id));
}
