/**
 * The model providers a user can bring their own key for (Settings →
 * Providers). Which providers there are, and where each one's endpoint is,
 * come from the runtime agent's providers.json: the agent can run a session
 * only on a provider listed there. This adds what the web app needs on top:
 * a name, what a key looks like, where to make one, and how to check it.
 *
 * Imports only the JSON, so the browser and the tests use it as is.
 */

import gateways from "@/runtime-agent/internal/claude/providers.json" with { type: "json" };

export type ProviderId = keyof typeof gateways;

/** How a key is checked before it's kept: a GET that answers 401 or 403 for a
 *  key the provider refuses. */
export type KeyCheck = { url: string; auth: "bearer" | "x-api-key"; headers?: Record<string, string> };

export type Provider = {
  id: ProviderId;
  label: string;
  /** What a key here is for, on Settings → Providers. */
  description: string;
  /** What a key looks like. Loose where the provider doesn't say, but never
   *  broader than the agent takes (claude.ValidGatewayToken). */
  keyPattern: RegExp;
  /** The input's placeholder. */
  keyPlaceholder: string;
  /** Where to make a key, and what to call that page. */
  keysUrl: string;
  keysPage: string;
  check: KeyCheck;
};

/** Every provider in providers.json, by id: one missing here fails the
 *  build. */
export const PROVIDERS: Record<ProviderId, Provider> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    description: "Models on your own OpenRouter account. OpenRouter bills you, with no Outrunner limit.",
    keyPattern: /^sk-or-[A-Za-z0-9-]{20,200}$/,
    keyPlaceholder: "Paste your OpenRouter API key (sk-or-…)",
    keysUrl: "https://openrouter.ai/settings/keys",
    keysPage: "OpenRouter → Keys",
    // Replaced by a check that also refuses a management key
    // (lib/providers/check.ts).
    check: { url: "https://openrouter.ai/api/v1/key", auth: "bearer" },
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude on your Anthropic API key, billed by Anthropic. Your Claude Pro or Max subscription goes in Settings → Claude.",
    keyPattern: /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,300}$/,
    keyPlaceholder: "Paste your Anthropic API key (sk-ant-api…)",
    keysUrl: "https://platform.claude.com/settings/keys",
    keysPage: "Claude Console → API keys",
    check: { url: "https://api.anthropic.com/v1/models", auth: "x-api-key", headers: { "anthropic-version": "2023-06-01" } },
  },
  zai: {
    id: "zai",
    label: "Z.ai",
    description: "GLM models on your Z.ai account, billed by Z.ai.",
    // An id and a secret, joined by a dot.
    keyPattern: /^[A-Za-z0-9._-]{20,300}$/,
    keyPlaceholder: "Paste your Z.ai API key",
    keysUrl: "https://z.ai/manage-apikey/apikey-list",
    keysPage: "Z.ai → API Keys",
    // Not the Anthropic-compatible path: its models list answers 200 to any key.
    check: { url: "https://api.z.ai/api/paas/v4/models", auth: "bearer" },
  },
  moonshot: {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    description: "Kimi models on your Moonshot account, billed by Moonshot.",
    keyPattern: /^sk-[A-Za-z0-9]{20,200}$/,
    keyPlaceholder: "Paste your Moonshot API key (sk-…)",
    keysUrl: "https://platform.kimi.ai/console/api-keys",
    keysPage: "Kimi platform → API Keys",
    check: { url: "https://api.moonshot.ai/v1/models", auth: "bearer" },
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek models on your DeepSeek account, billed by DeepSeek.",
    keyPattern: /^sk-[A-Za-z0-9]{20,200}$/,
    keyPlaceholder: "Paste your DeepSeek API key (sk-…)",
    keysUrl: "https://platform.deepseek.com/api_keys",
    keysPage: "DeepSeek → API keys",
    check: { url: "https://api.deepseek.com/models", auth: "bearer" },
  },
};

/** The providers, in providers.json's order. */
export const PROVIDER_IDS = Object.keys(gateways) as ProviderId[];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && Object.hasOwn(gateways, value);
}

/** A Claude subscription token (`claude setup-token`): it belongs in
 *  Settings → Claude, not with a provider. */
const CLAUDE_TOKEN = /^sk-ant-oat/;

/** Providers whose keys are told apart by their prefix, so a key pasted into
 *  the wrong card can be sent to the right one. */
const DISTINCT: ProviderId[] = ["openrouter", "anthropic"];

/**
 * Whether `key` can be saved as `provider`'s, and if not, what to tell the
 * user. Format only: the provider itself is asked afterwards.
 */
export function keyProblem(provider: ProviderId, key: string): string | null {
  const { label, keyPattern, keysPage } = PROVIDERS[provider];
  if (CLAUDE_TOKEN.test(key)) {
    return "That's a Claude subscription token. Connect it in Settings → Claude instead.";
  }
  const belongs = DISTINCT.find((other) => other !== provider && PROVIDERS[other].keyPattern.test(key));
  if (belongs) return `That key is for ${PROVIDERS[belongs].label}. Save it under ${PROVIDERS[belongs].label} instead.`;
  if (!keyPattern.test(key)) return `That doesn't look like a ${label} API key. Copy one from ${keysPage}.`;
  return null;
}
