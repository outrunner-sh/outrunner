import { optionalEnv } from "@/lib/env";
import { AGENT_REPLY_SCHEMA, type ChatMessage } from "@/lib/slack/agent";

/** The model the Slack agent thinks with (OpenRouter's id); SLACK_AGENT_MODEL
 *  changes it. */
export function agentModel(): string {
  return optionalEnv("SLACK_AGENT_MODEL") || "anthropic/claude-sonnet-5.5";
}

const COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 60_000;

/**
 * One turn of the Slack agent: the conversation in, the model's JSON answer
 * out (lib/slack/agent.ts parses it), on the org's key. Throws on a refused
 * or failed call; the caller tells the thread.
 */
export async function agentTurn(key: string, messages: ChatMessage[]): Promise<string> {
  const response = await fetch(COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Title": "Outrunner Slack agent",
    },
    body: JSON.stringify({
      model: agentModel(),
      messages,
      response_format: { type: "json_schema", json_schema: AGENT_REPLY_SCHEMA },
      max_tokens: 4000,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string | null } }[];
    error?: { message?: string };
  } | null;
  if (!response.ok) throw new Error(`The model call failed (${response.status}): ${body?.error?.message ?? "no detail"}`);
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error("The model answered with nothing.");
  return content;
}
