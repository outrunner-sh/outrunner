import { z } from "zod";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { isErrorReply, isInterruption, messageText } from "@/lib/runtime/conversation-events";
import { EFFORTS, type RecordedModel } from "@/lib/runtime/session-models";
import { PROVIDER_IDS } from "@/lib/providers/registry";

export const HARNESS_SWITCH_FEATURE = "harness-switch-v1";

export const HarnessSelection = z.object({
  model: z.object({ id: z.string().min(1), provider: z.enum(["outrunner", "claude", "codex", ...PROVIDER_IDS]), label: z.string() }).passthrough(),
  effort: z.enum(EFFORTS).nullable(),
});
export const HarnessStatus = z.object({ harness: z.object({
  id: z.string(), agent: z.enum(["claude", "codex"]), selection: HarnessSelection,
  delivered: z.boolean(),
  saved: z.boolean().optional(),
  mode: z.enum(["build", "plan"]).optional(),
}).nullable() });
export type HarnessStatus = z.infer<typeof HarnessStatus>;
export const PendingHarness = z.object({
  id: z.string(), agent: z.enum(["claude", "codex"]), expectedAgent: z.enum(["claude", "codex"]), selection: HarnessSelection,
  request: z.object({ content: z.string(), attachmentIds: z.array(z.string()), resume: z.boolean(), mode: z.enum(["build", "plan"]).optional() }).optional(),
});
export type PendingHarness = z.infer<typeof PendingHarness>;
export function harnessRecorded(state: NonNullable<HarnessStatus["harness"]>): RecordedModel {
  return state.selection as RecordedModel;
}

/** Narrow quota signals, only in a runtime failure record. Ordinary assistant
 * prose about limits is never interpreted as an exhausted account. */
export function exhaustion(events: AgentEvent[]): "quota" | "credits" | null {
  const last = [...events].reverse().find((e) => e.t === "message" && !e.compact);
  if (!last || (last.t === "message" && last.harness) || !isErrorReply(last)) return null;
  const text = messageText(last);
  if (/\b(insufficient[_ ](?:credits|quota)|(?:out of|not enough) credits|credit balance is too low)\b/i.test(text)) return "credits";
  if (/\b(you(?:'ve| have) (?:hit|reached) your (?:usage )?limit|usage limit (?:reached|exceeded)|weekly limit|limit reached.*resets)\b/i.test(text)) return "quota";
  return null;
}

export function hasUnfinishedRequest(events: AgentEvent[]): boolean {
  let pending = false;
  for (const event of events) {
    if (event.t !== "message" || event.meta || event.compact || event.harness) continue;
    if (isInterruption(event)) { pending = true; continue; }
    if (event.role === "user" && messageText(event)) pending = true;
    if (event.role === "assistant") {
      const last = event.content.at(-1);
      if (isErrorReply(event)) pending = true;
      else if (last?.type === "text" && event.stopReason !== "tool_use") pending = false;
      else if (last) pending = true;
    }
  }
  return pending;
}
