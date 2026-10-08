import { AgentRequestError } from "@/lib/runtime/agent-client";

/** What to tell the user when a cloud session's agent refuses or fails a model
 *  switch, and the status to answer with. */
export function switchFailure(error: unknown): { status: number; message: string } {
  if (error instanceof AgentRequestError) {
    // Mid-turn, or tmux couldn't say: the agent's message says what to do.
    if (error.error?.code === "CONFLICT") return { status: 409, message: error.error.message };
    // No error envelope: the route itself is missing, from an agent deployed
    // before sessions could switch models.
    if (error.status === 404 && !error.error) {
      return {
        status: 409,
        message: "This project's cloud computer runs an older Outrunner that can't switch models.",
      };
    }
  }
  return { status: 502, message: "Couldn't switch models. Please try again." };
}
