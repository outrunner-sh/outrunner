import { isProviderId } from "@/lib/providers/registry";
import type { ModelProvider } from "@/lib/runtime/session-models";

/** Local sessions have no server model row; their last explicit provider is
 * retained as a hint. Cloud sessions always prefer the recorded choice. */
export function pickedProvider(workspaceId: string): ModelProvider | null {
  try {
    const saved = window.localStorage.getItem(`outrunner:model-key:${workspaceId}`);
    if (saved === "own") return "openrouter";
    if (saved === "neev") return "outrunner";
    return saved === "outrunner" || saved === "claude" || saved === "codex" || isProviderId(saved) ? saved : null;
  } catch { return null; }
}

export function rememberPickedProvider(workspaceId: string, provider: ModelProvider): void {
  try {
    window.localStorage.setItem(`outrunner:model-key:${workspaceId}`, provider);
  } catch {
    // Blocked storage only costs the tick going back to the default.
  }
}
