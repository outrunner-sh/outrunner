import { resolveAgentAuth, type AgentAuthStore } from "@/lib/agents/resolve";
import { codexCatalog } from "@/lib/codex/model-catalog";
import { createCodexProxy } from "@/lib/codex/inference";
import { authorizeGrant, readGrant } from "@/lib/codex/grant";
import { codexAccounts } from "@/lib/codex/store";
import { BOX_TOOLS } from "@/lib/runtime/box-image";
import { CODEX_MODELS, type SessionModel } from "@/lib/runtime/session-models";

/** Resolve the exact credential selected by the existing personal/org resolver.
 * A failed discovery offers no guessed account models and leaks no credentials. */
export async function codexModelsFor(store: AgentAuthStore): Promise<SessionModel[]> {
  try {
    const auth = await resolveAgentAuth(store, "codex", "cloud");
    const credential = auth.credential;
    if (credential?.kind === "codex-account") {
      const { bearer } = JSON.parse(Buffer.from(credential.token, "base64url").toString()) as { bearer: string };
      const proxy = createCodexProxy({ readGrant, authorize: authorizeGrant, accounts: codexAccounts, fetch });
      const response = await proxy(new Request(`https://catalog.internal/models?client_version=${BOX_TOOLS.codex}`, {
        headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(8000),
      }), { params: Promise.resolve({ path: ["models"] }) });
      return response.ok ? codexCatalog(await response.json()) : [];
    }
    if (credential?.kind === "openai-api-key") {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${credential.token}` }, signal: AbortSignal.timeout(8000), redirect: "error",
      });
      if (!response.ok) return [];
      const data = await response.json() as { data?: { id: string }[] };
      // Runtime registry suggestions intersect the key's actual access. The
      // API's ID-only listing establishes neither vision nor effort support.
      const ids = new Set(data.data?.map((m) => m.id));
      return CODEX_MODELS.filter((m) => ids.has(m.id)).map((m) => ({ id: m.id, label: m.label, provider: "codex", efforts: [] }));
    }
  } catch { /* No silent change of credential or billing owner on failure. */ }
  return [];
}

/** Organization settings inspect only shared credentials, never the viewing
 * admin's personal account. Sessions still use the normal personal precedence. */
export async function codexOrgModelsFor(user: string, org: string): Promise<SessionModel[]> {
  const [{ sealedOrgKeys, openOrgKey }, { codexStore }, { inferenceGrant }] = await Promise.all([
    import("@/lib/db/org-credentials"), import("@/lib/codex/store"), import("@/lib/codex/grant"),
  ]);
  const [keys, account] = await Promise.all([sealedOrgKeys(user, org, ["openai"]), codexStore.read(`org:${org}`)]);
  return codexModelsFor({ load: async () => ({
    choice: account && account.status === "connected" ? "codex-account" : "api-key",
    open: (credential) => credential.kind === "codex-account" && account
      ? inferenceGrant(user, org, account)
      : credential.kind === "provider-key" && credential.provider === "openai" ? openOrgKey(keys.get("openai"), org, "openai") : null,
  }) });
}
