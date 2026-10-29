import { searchSkillsApi } from "@/lib/api/environment-skills";
import { apiRoute } from "@/lib/api/handler";

/** Search the skills.sh catalog, `?q=`. (docs/api.md) */
export function GET(request: Request) {
  return apiRoute(request, searchSkillsApi);
}
