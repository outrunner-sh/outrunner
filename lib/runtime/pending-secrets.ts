/**
 * The request for secrets a session's agent is waiting on the user to
 * answer: its call of Outrunner's request_secrets tool
 * (runtime-agent/internal/ask/secrets.go) with no result yet. The composer
 * gives way to a form for it (components/secrets-card.tsx). The call names
 * variables; their values go from the form to the session, never into the
 * conversation.
 *
 * Pure (no React), so it is unit-tested in Node.
 */
import { z } from "zod";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { pendingToolCall } from "@/lib/runtime/pending-question";

/** The tool as Claude names it. */
export const SECRETS_TOOL = "mcp__outrunner__request_secrets";

const SecretsInput = z.object({
  reason: z.string(),
  keys: z
    .array(z.object({ name: z.string(), description: z.string().optional(), optional: z.boolean().optional() }))
    .min(1)
    .max(10),
});

export type SecretKey = z.infer<typeof SecretsInput>["keys"][number];

export type PendingSecretRequest = {
  /** The tool call's id: the form it shows is answered once. */
  toolUseId: string;
  reason: string;
  keys: SecretKey[];
};

/** The newest request_secrets call still waiting on an answer, or null. */
export function pendingSecretRequest(events: AgentEvent[]): PendingSecretRequest | null {
  const call = pendingToolCall(events, SECRETS_TOOL);
  if (!call) return null;
  const parsed = SecretsInput.safeParse(call.input);
  // The agent refuses one that doesn't parse too: no form to answer.
  if (!parsed.success) return null;
  return { toolUseId: call.id, reason: parsed.data.reason, keys: parsed.data.keys };
}

/** The values a form can send: every required variable has one. Blank
 *  ones are left out (an optional variable not given). */
export function providedValues(request: PendingSecretRequest, values: Record<string, string>): Record<string, string> | null {
  const provided: Record<string, string> = {};
  for (const key of request.keys) {
    const value = values[key.name] ?? "";
    if (value.trim() === "") {
      if (!key.optional) return null;
      continue;
    }
    provided[key.name] = value;
  }
  return provided;
}
