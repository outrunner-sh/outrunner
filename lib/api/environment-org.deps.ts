import { projectOutsideOrg as outsideOrg } from "@/lib/api/environment-org";
import type { ApiContext } from "@/lib/api/handler";
import { getEnvironment } from "@/lib/db/environments";

/** lib/api/environment-org.ts's check, looked up in the database. */
export function projectOutsideOrg(context: ApiContext, id: string): Promise<Response | null> {
  return outsideOrg(context, id, getEnvironment);
}
