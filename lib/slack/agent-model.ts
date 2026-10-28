import { optionalEnv } from "@/lib/env";
import { AGENT_TOOLS, type ChatMessage, REPLY_TOOL } from "@/lib/slack/agent";

/** The model the Slack agent thinks with (OpenRouter's id); SLACK_AGENT_MODEL
 *  changes it. */
export function agentModel(): string {
  return optionalEnv("SLACK_AGENT_MODEL") || "anthropic/claude-sonnet-5.5";
}

const COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 60_000;
/** Lookups a turn may make before it must reply. */
const MAX_TOOL_ROUNDS = 5;

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message =
  | ChatMessage
  | { role: "assistant"; content: string | null; tool_calls: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** A lookup the agent may call, by name: its arguments in, JSON out. */
export type Lookups = Record<string, (args: Record<string, unknown>) => Promise<string>>;

async function complete(key: string, messages: Message[]) {
  const response = await fetch(COMPLETIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Outrunner Slack agent" },
    body: JSON.stringify({
      model: agentModel(),
      messages,
      tools: AGENT_TOOLS,
      // Newer Claude models refuse a forced tool_choice: the prompt asks for
      // the reply tool, and plain text is taken as an answer.
      tool_choice: "auto",
      max_tokens: 4000,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    error?: { message?: string };
  } | null;
  if (!response.ok) throw new Error(`The model call failed (${response.status}): ${body?.error?.message ?? "no detail"}`);
  return body?.choices?.[0]?.message ?? null;
}

/**
 * One turn of the Slack agent, on the org's key: the model may call the
 * lookups (each answered, up to MAX_TOOL_ROUNDS rounds) and ends by calling
 * `reply`, whose arguments come back as JSON for lib/slack/agent.ts to check.
 * A lookup that fails tells the model so rather than ending the turn.
 */
export async function agentTurn(key: string, conversation: ChatMessage[], lookups: Lookups = {}): Promise<string> {
  const messages: Message[] = [...conversation];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (round === MAX_TOOL_ROUNDS) {
      messages.push({ role: "user", content: "That's enough looking up: call the reply tool now with what you have." });
    }
    const message = await complete(key, messages);
    const calls = message?.tool_calls ?? [];
    const reply = calls.find((c) => c.function.name === REPLY_TOOL);
    if (reply) return reply.function.arguments;
    if (calls.length === 0) {
      // Plain text without the tool: taken as an answer.
      const text = message?.content?.trim();
      if (text) return JSON.stringify({ action: "answer", message: text, spec: null, research: null });
      throw new Error("The model answered with nothing.");
    }
    messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let result: string;
      const lookup = lookups[call.function.name];
      try {
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        result = lookup ? await lookup(args) : JSON.stringify({ error: `No tool ${call.function.name}.` });
      } catch (error) {
        console.error(`Slack agent: the lookup ${call.function.name} failed`, error);
        result = JSON.stringify({ error: "That lookup failed." });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 20_000) });
    }
  }
  throw new Error("The model kept looking things up without replying.");
}
