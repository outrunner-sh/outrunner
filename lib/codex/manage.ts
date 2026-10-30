import { createCodexManagement } from "@/lib/codex/management";
import { codexAccounts, codexStore } from "@/lib/codex/store";
import { memberRole } from "@/lib/db/orgs";
import { recordAudit } from "@/lib/audit/record";
import type { Owner } from "@/lib/auth/owner";

const manage = createCodexManagement({
  accounts: codexAccounts,
  store: codexStore,
  memberRole,
  fetch,
});
export async function manageCodex(
  request: Request,
  owner: Owner,
  org: string | null,
  body?: unknown,
) {
  const response = await manage(request, owner.id, org, body);
  if (
    response.ok &&
    org &&
    (request.method === "PUT" || request.method === "DELETE")
  ) {
    await recordAudit({
      orgId: org,
      actor: owner,
      action: request.method === "PUT" ? "key.saved" : "key.removed",
      resource: {
        type: "key",
        id: "codex-account",
        label: "Codex ChatGPT account",
      },
    });
  }
  return response;
}
