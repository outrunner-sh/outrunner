import type { OutrunnerModels } from "@/lib/desktop/local-runtime";
/** Fictitious IDs ensure the selector follows runtime metadata, not a copied
 * product screenshot or the generic OpenAI suggestions. No real credentials. */
export const selectionMenu: OutrunnerModels = {
  outrunner: true, allowance: true, keys: ["zai"], available: true,
  harnesses: ["claude", "codex"],
  agents: { claude: { cloud: true, local: false }, codex: { cloud: true, local: false } },
  codexModels: [
    { id: "account-code", label: "Account coding model", provider: "codex", supportsImages: true, efforts: ["low", "high"], defaultEffort: "low" },
    { id: "account-text", label: "Account text model", provider: "codex", supportsImages: false, efforts: ["medium"] },
  ],
  loadout: { models: [{ provider: "codex", id: "account-code", effort: "high" }], default: { provider: "codex", id: "account-code", effort: "high" } },
};
