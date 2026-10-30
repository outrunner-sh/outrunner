/**
 * The model providers a user can bring their own key for (Settings →
 * Providers). Two kinds:
 *   - the gateways, which Claude Code runs through (Anthropic-compatible
 *     endpoints). Which there are, and where each one's endpoint is, come from
 *     the runtime agent's providers.json: the agent can run a session only on
 *     a gateway listed there;
 *   - OpenAI, whose key is Codex's (lib/agents/registry.ts). It has no
 *     Anthropic-compatible endpoint, so Claude Code can't run on it.
 * This adds what the web app needs on top: a name, what a key looks like,
 * where to make one, and how to check it.
 *
 * Imports only the JSON, so the browser and the tests use it as is.
 */

import gateways from "@/runtime-agent/internal/claude/providers.json" with { type: "json" };

/** A gateway: one Claude Code can run through. */
export type ProviderId = keyof typeof gateways;

/** Any provider a user can save a key for: a gateway, or OpenAI. */
export type KeyProviderId = ProviderId | "openai";

/** How a key is checked before it's kept: a GET that answers 401 or 403 for a
 *  key the provider refuses. */
export type KeyCheck = { url: string; auth: "bearer" | "x-api-key"; headers?: Record<string, string> };

export type Provider = {
  id: KeyProviderId;
  label: string;
  /** What a key here is for, on Settings → Providers. */
  description: string;
  /** What a key looks like. Loose where the provider doesn't say, but never
   *  broader than the agent takes (claude.ValidGatewayToken). */
  keyPattern: RegExp;
  /** A start only this provider's keys have, so one pasted into another's
   *  card can be sent here. None where keys share a shape (`sk-…`). */
  distinctPrefix?: RegExp;
  /** The input's placeholder. */
  keyPlaceholder: string;
  /** Where to make a key, and what to call that page. */
  keysUrl: string;
  keysPage: string;
  /** Where the provider shows what the key spent, where that has a page of
   *  its own; else its keys page, in the same console (usageDashboard). */
  usageUrl?: string;
  check: KeyCheck;
  /** The models the menu offers on the user's key, by the provider's own
   *  names: a few good ones, with any other a custom id away. Each says
   *  whether it can see images (SessionModel.supportsImages). */
  models: { id: string; label: string; supportsImages: boolean }[];
};

/** Every provider in providers.json, and OpenAI, by id: one missing here
 *  fails the build. */
export const PROVIDERS: Record<KeyProviderId, Provider> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    description: "Models on your own OpenRouter account. OpenRouter bills you, with no Outrunner limit.",
    keyPattern: /^sk-or-[A-Za-z0-9-]{20,200}$/,
    distinctPrefix: /^sk-or-/,
    keyPlaceholder: "Paste your OpenRouter API key (sk-or-…)",
    keysUrl: "https://openrouter.ai/settings/keys",
    keysPage: "OpenRouter → Keys",
    usageUrl: "https://openrouter.ai/activity",
    // Replaced by a check that also refuses a management key
    // (lib/providers/check.ts).
    check: { url: "https://openrouter.ai/api/v1/key", auth: "bearer" },
    models: [
      { id: "z-ai/glm-5.3", label: "GLM 5.3", supportsImages: false },
      { id: "moonshotai/kimi-k3", label: "Kimi K3", supportsImages: true },
      { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", supportsImages: false },
      { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", supportsImages: true },
      { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", supportsImages: true },
    ],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude on your Anthropic API key, billed by Anthropic. Your Claude Pro or Max subscription goes under Claude subscription.",
    keyPattern: /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,300}$/,
    distinctPrefix: /^sk-ant-api/,
    keyPlaceholder: "Paste your Anthropic API key (sk-ant-api…)",
    keysUrl: "https://platform.claude.com/settings/keys",
    keysPage: "Claude Console → API keys",
    usageUrl: "https://platform.claude.com/usage",
    check: { url: "https://api.anthropic.com/v1/models", auth: "x-api-key", headers: { "anthropic-version": "2023-06-01" } },
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", supportsImages: true },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", supportsImages: true },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", supportsImages: true },
    ],
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
    models: [
      { id: "glm-5.3", label: "GLM 5.3", supportsImages: false },
      { id: "glm-5.3-flash", label: "GLM 5.3 Flash", supportsImages: true },
    ],
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
    models: [
      { id: "kimi-k3", label: "Kimi K3", supportsImages: true },
      { id: "kimi-k2.6", label: "Kimi K2.6", supportsImages: true },
    ],
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek models on your DeepSeek account, billed by DeepSeek.",
    keyPattern: /^sk-[A-Za-z0-9]{20,200}$/,
    keyPlaceholder: "Paste your DeepSeek API key (sk-…)",
    keysUrl: "https://platform.deepseek.com/api_keys",
    keysPage: "DeepSeek → API keys",
    usageUrl: "https://platform.deepseek.com/usage",
    check: { url: "https://api.deepseek.com/models", auth: "bearer" },
    models: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", supportsImages: false },
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", supportsImages: false },
    ],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    description: "Codex on your OpenAI API key, billed by OpenAI.",
    // A project or service account key, or an older user key (sk- and
    // letters, which DeepSeek's and Moonshot's share). An admin key is refused
    // before this (keyProblem): it can't run a model.
    keyPattern: /^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,300}$/,
    distinctPrefix: /^sk-(?:proj|svcacct)-/,
    keyPlaceholder: "Paste your OpenAI API key (sk-proj-…)",
    keysUrl: "https://platform.openai.com/api-keys",
    keysPage: "OpenAI → API keys",
    usageUrl: "https://platform.openai.com/usage",
    check: { url: "https://api.openai.com/v1/models", auth: "bearer" },
    // Codex's models on an API key. Account sign-in uses its native catalog.
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", supportsImages: true },
      { id: "gpt-6-sol", label: "GPT-6 Sol", supportsImages: true },
      { id: "gpt-6-luna", label: "GPT-6 Luna", supportsImages: true },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", supportsImages: true },
    ],
  },
};

/** Where to see what a key of `provider`'s has spent, on the provider's site. */
export function usageDashboard(provider: KeyProviderId): string {
  return PROVIDERS[provider].usageUrl ?? PROVIDERS[provider].keysUrl;
}

/** The gateways, in providers.json's order. */
export const PROVIDER_IDS = Object.keys(gateways) as ProviderId[];

/** Every provider a key can be saved for: the gateways, then OpenAI. */
export const KEY_PROVIDER_IDS: KeyProviderId[] = [...PROVIDER_IDS, "openai"];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && Object.hasOwn(gateways, value);
}

export function isKeyProviderId(value: unknown): value is KeyProviderId {
  return value === "openai" || isProviderId(value);
}

/** The providers among a user's saved keys whose key `opens`, in the
 *  registry's order; rows for a provider this release doesn't know are
 *  dropped. */
export function usableProviders<Row extends { provider: string }>(
  rows: Row[],
  opens: (row: Row, provider: ProviderId) => boolean,
): ProviderId[] {
  const usable = new Set<ProviderId>();
  for (const row of rows) {
    if (isProviderId(row.provider) && opens(row, row.provider)) usable.add(row.provider);
  }
  return PROVIDER_IDS.filter((id) => usable.has(id));
}

/** A Claude subscription token (`claude setup-token`): it belongs in
 *  Claude Code's Subscription, not with a provider. */
const CLAUDE_TOKEN = /^sk-ant-oat/;

/** An OpenAI admin key: it manages an organization, and can't run a model. */
const OPENAI_ADMIN_KEY = /^sk-admin-/;

/** Where a provider's key is saved, for a message sending it there: an
 *  agent's key under that agent, any other under its own name. */
function savedUnder(provider: KeyProviderId): string {
  if (provider === "anthropic") return "Claude Code → API key";
  if (provider === "openai") return "Codex → API key";
  return PROVIDERS[provider].label;
}

/**
 * Whether `key` can be saved as `provider`'s, and if not, what to tell the
 * user. Format only: the provider itself is asked afterwards.
 */
export function keyProblem(provider: KeyProviderId, key: string): string | null {
  const { label, keyPattern, keysPage } = PROVIDERS[provider];
  if (CLAUDE_TOKEN.test(key)) {
    return "That's a Claude subscription token. Connect it under Personal → Coding agents → Claude Code → Subscription instead.";
  }
  if (OPENAI_ADMIN_KEY.test(key)) {
    return "That's an OpenAI admin key, which can't run models. Create a project API key at OpenAI → API keys.";
  }
  const belongs = KEY_PROVIDER_IDS.find(
    (other) => other !== provider && PROVIDERS[other].distinctPrefix?.test(key),
  );
  if (belongs) return `That key is for ${PROVIDERS[belongs].label}. Save it under ${savedUnder(belongs)} instead.`;
  if (!keyPattern.test(key)) return `That doesn't look like a ${label} API key. Copy one from ${keysPage}.`;
  return null;
}
