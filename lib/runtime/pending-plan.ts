/**
 * The plan a session's agent proposed and is waiting on: Claude's ExitPlanMode
 * call (its menu asks the terminal to approve it), or, from Codex, which has
 * no plan step, the reply that ends a turn sent in plan mode. The timeline
 * shows it as a plan card, with Approve (build it) and Revise (say what to
 * change) while it waits.
 */

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { isInterruption, messageText } from "@/lib/runtime/conversation-events";

/** Claude's tool for a plan ready for approval. */
export const EXIT_PLAN_MODE = "ExitPlanMode";

export type PendingPlan = {
  /** The tool call's id (Claude), or the reply's uuid (Codex): the card's. */
  id: string;
  plan: string;
  /** Whether answering it closes a menu first (Claude's, in its terminal). */
  dismiss: boolean;
};

/** The plan in an ExitPlanMode call's input, or null where it has none.
 *  Claude Code 2.1.304 keeps the plan in a file and puts its text in the call
 *  too (`plan`, beside `planFilePath`); where the text isn't there, the card
 *  says where the file is, so the plan can still be approved. */
export function planOf(input: unknown): string | null {
  const { plan, planFilePath } = (input ?? {}) as { plan?: unknown; planFilePath?: unknown };
  if (typeof plan === "string" && plan.trim() !== "") return plan;
  if (typeof planFilePath === "string" && planFilePath !== "") return `The plan is in \`${planFilePath}\`.`;
  return null;
}

/**
 * The plan waiting on the user, if any: the newest ExitPlanMode call without
 * a result, nothing after it; or, where `plansInProse` (Codex), the last words
 * of a turn sent in plan mode that is over (`working` false), with no prompt
 * since. Null once anything else has happened.
 */
export function pendingPlan(events: AgentEvent[], { plansInProse = false, working = false } = {}): PendingPlan | null {
  const answered = new Set<string>();
  for (const event of events) {
    if (event.t !== "message") continue;
    for (const block of event.content) if (block.type === "tool_result") answered.add(block.toolUseId);
  }
  let reply: { id: string; text: string } | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.t !== "message") continue;
    if (event.compact) return null;
    if (event.role === "user") {
      if (isInterruption(event)) return null;
      if (event.content.some((b) => b.type === "tool_result")) continue;
      // The prompt that started the turn: a plan's, for Codex's words to be one.
      if (plansInProse && !working && reply && event.mode === "plan") {
        return { id: reply.id, plan: reply.text, dismiss: false };
      }
      return null;
    }
    for (let b = event.content.length - 1; b >= 0; b--) {
      const block = event.content[b];
      if (block.type === "tool_use" && block.name === EXIT_PLAN_MODE) {
        const plan = planOf(block.input);
        // Words after the call mean it was answered, whatever the log says.
        return plan && !answered.has(block.id) && !plansInProse && !reply ? { id: block.id, plan, dismiss: true } : null;
      }
    }
    if (!reply && event.role === "assistant") {
      const text = messageText(event);
      if (text) reply = { id: event.uuid, text };
    }
  }
  return null;
}

/** A plan's file name, from its first heading where it has one: plan-add-dark-mode.md. */
export function planFileName(text: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1] ?? "";
  const slug = heading
    .toLowerCase()
    .replace(/^plan:?\s*/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug ? `plan-${slug}.md` : "plan.md";
}
