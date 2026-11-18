/**
 * The project (an `environments` row) a public API call names, as every
 * project endpoint reads it: one the caller may see, in the key's org.
 */

import { apiError } from "@/lib/api/errors";
import type { ApiContext } from "@/lib/api/handler";
import { type Environment, getEnvironment } from "@/lib/db/environments";
import { isUuid } from "@/lib/ids";

export const projectNotFound = () => apiError(404, "No project by that id that you can see.");

/** The project, if it's in the key's org and the caller may see it. */
export async function projectOf(context: ApiContext, id: string): Promise<Environment | Response> {
  if (!isUuid(id)) return projectNotFound();
  const environment = await getEnvironment(context.caller.userId, id);
  return environment && environment.orgId === context.caller.orgId ? environment : projectNotFound();
}
