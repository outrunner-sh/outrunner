/**
 * The coding agents a session can run, and the ways each can sign in
 * (Settings → Providers, a tab per agent, a card per way). The user picks one
 * way per agent, kept in user_agent_auth; lib/agents/resolve.ts turns that
 * pick into what a session runs on, or says why it can't.
 *
 * Imports only the provider registry, so the browser and the tests use it as is.
 */

import type { KeyProviderId } from "@/lib/providers/registry";

export type AgentId = "claude" | "codex";

/** The agents, in the order their tabs show. */
export const AGENT_IDS: AgentId[] = ["claude", "codex"];

export type AuthMethodId = "subscription" | "chatgpt" | "local" | "api-key";

/** Where a session runs: a box Outrunner runs, or the user's own Mac. */
export type RunTarget = "cloud" | "local";

/** What a way of signing in runs on:
 *   - `claude-slot`: the Claude subscription token saved with Outrunner;
 *   - `provider-key`: the user's key for a provider, saved with Outrunner;
 *   - `own-login`: whatever the agent's CLI on the Mac is logged in with.
 *     Outrunner never sees it, so it can't reach a box Outrunner runs. */
export type AuthCredential =
  | { kind: "claude-slot" }
  | { kind: "provider-key"; provider: KeyProviderId }
  | { kind: "own-login" };

export type AuthMethod = {
  id: AuthMethodId;
  /** The card's name. */
  label: string;
  /** A line under the card's details. */
  description: string;
  targets: RunTarget[];
  credential: AuthCredential;
};

export type Agent = {
  id: AgentId;
  label: string;
  /** Its CLI, as a user would type it. */
  command: string;
  /** Its ways of signing in, in the order their cards show. */
  methods: AuthMethod[];
};

const LOCAL_AGENT: Omit<AuthMethod, "description"> = {
  id: "local",
  label: "Local agent",
  targets: ["local"],
  credential: { kind: "own-login" },
};

export const AGENTS: Record<AgentId, Agent> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    methods: [
      {
        id: "subscription",
        label: "Subscription",
        description: "Your Claude Pro or Max plan, on sessions here and on your Mac, within the plan's limits.",
        targets: ["cloud", "local"],
        credential: { kind: "claude-slot" },
      },
      {
        ...LOCAL_AGENT,
        description: "Claude Code on your Mac, signed in as it already is. For local sessions only.",
      },
      {
        id: "api-key",
        label: "API key",
        description: "Your Anthropic API key, billed by Anthropic, on sessions here and on your Mac.",
        targets: ["cloud", "local"],
        credential: { kind: "provider-key", provider: "anthropic" },
      },
    ],
  },
  codex: {
    id: "codex",
    label: "Codex",
    command: "codex",
    methods: [
      {
        id: "chatgpt",
        label: "ChatGPT",
        description:
          "Your ChatGPT plan, through Codex's own ChatGPT sign-in on your Mac. For local sessions only: sessions here need an API key.",
        targets: ["local"],
        credential: { kind: "own-login" },
      },
      {
        ...LOCAL_AGENT,
        description: "Codex on your Mac, signed in as it already is. For local sessions only.",
      },
      {
        id: "api-key",
        label: "API key",
        description: "Your OpenAI API key, billed by OpenAI, on sessions here and on your Mac.",
        targets: ["cloud", "local"],
        credential: { kind: "provider-key", provider: "openai" },
      },
    ],
  },
};

export function isAgentId(value: unknown): value is AgentId {
  return value === "claude" || value === "codex";
}

/** `agent`'s way of signing in called `method`, or null when it has none. */
export function authMethod(agent: AgentId, method: unknown): AuthMethod | null {
  return AGENTS[agent].methods.find((m) => m.id === method) ?? null;
}

/** The agent whose API key a provider's is, if any: Anthropic's is Claude
 *  Code's, OpenAI's is Codex's. */
export function agentOfKey(provider: KeyProviderId): AgentId | null {
  for (const agent of AGENT_IDS) {
    for (const { credential } of AGENTS[agent].methods) {
      if (credential.kind === "provider-key" && credential.provider === provider) return agent;
    }
  }
  return null;
}
